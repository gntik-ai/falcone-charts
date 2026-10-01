-- Run with Lua/LuaJIT from the repository root. APISIX dependencies are stubbed
-- so issuer selection, rejection and cache behavior can be checked offline.
local now = 1000
local fetches = 0
local decoded = {}
local responses = {}
local last_response
local reply_status = 200
local reply_body = "keys"
local fail_fetch = false

ngx = {
    now = function() return now end,
    time = function() return now end,
    decode_base64 = function(value) return decoded[value] end,
    encode_base64 = function() return "cHVibGlj" end,
}
package.preload["apisix.core"] = function()
    return {
        request = {header = function(ctx) return ctx.authorization end},
        schema = {check = function() return true end},
    }
end
package.preload["cjson.safe"] = function()
    return {decode = function(value) return responses[value] end}
end
package.preload["resty.http"] = function()
    return {new = function()
        return {
            set_timeout = function() end,
            request_uri = function(_, uri)
                fetches = fetches + 1
                last_response = uri
                if fail_fetch then return nil end
                return {status = reply_status, body = reply_body}
            end,
        }
    end}
end
package.preload["resty.jwt"] = function()
    return {verify = function(_, _, token)
        return {verified = token:match("%.good$") ~= nil}
    end}
end

local plugin
local platform = "https://iam/realms/platform"
local tenant = "https://iam/realms/tenant-a"
local foreign = "https://other/realms/tenant-a"
local conf = {issuer_base_url = "https://iam", jwks_base_url = "https://internal-iam",
    platform_realm = "platform", audience = "api", cache_ttl = 10, cache_max_entries = 2, timeout = 1}
local valid_keys = {keys = {{kid = "key-1", kty = "RSA", x5c = {"Y2VydA=="}}}}
responses.keys = valid_keys

local function reset()
    plugin = dofile("charts/in-falcone/files/apisix/plugins/issuer-jwks-auth.lua")
    fetches = 0
    last_response = nil
    reply_status = 200
    reply_body = "keys"
    fail_fetch = false
    responses.keys = valid_keys
    now = now + 100
end

local function call(header, payload, signature)
    decoded["h==="] = "header"
    decoded["p==="] = "payload"
    responses.header = header
    responses.payload = payload
    return plugin.rewrite(conf, {authorization = "Bearer h.p." .. (signature or "good")})
end

local function claims(iss)
    return {iss = iss, aud = "api", exp = now + 60}
end

local header = {alg = "RS256", kid = "key-1"}
reset()
assert(plugin.rewrite(conf, {}) == 401, "missing Authorization must reject")
for _, authorization in ipairs({"Bearer garbage", "Bearer h.p", "Bearer h.p.good.extra", "Basic h.p.good"}) do
    assert(plugin.rewrite(conf, {authorization = authorization}) == 401, "malformed token must reject")
end
assert(fetches == 0, "malformed tokens must not fetch")
assert(call(header, claims(platform)) == nil)
assert(fetches == 1 and last_response == "https://internal-iam/realms/platform/protocol/openid-connect/certs")
assert(call(header, claims(platform)) == nil and fetches == 1, "valid cached keys must avoid a fetch")
assert(call(header, claims(foreign)) == 401)
for _, issuer in ipairs({"https://iam/realms/../other", "https://iam/realms/a%2Fb",
    "https://iam/realms/a/b", "https://iam/realms/a?b", "https://iam/realms/a#b"}) do
    assert(call(header, claims(issuer)) == 401)
end
assert(fetches == 1, "foreign and invalid realms must never cause a fetch")
assert(call(header, claims(platform), "bad") == 401, "bad signature must reject")
assert(call({alg = "none", kid = "key-1"}, claims(platform)) == 401)
assert(call({alg = "HS256", kid = "key-1"}, claims(platform)) == 401)
local expired = claims(platform)
expired.exp = now - 1
assert(call(header, expired) == 401)
local wrong_audience = claims(platform)
wrong_audience.aud = "other"
assert(call(header, wrong_audience) == 401)
local tenant_other_audience = claims(tenant)
tenant_other_audience.aud = "tenant-client"
assert(call(header, tenant_other_audience) == nil, "tenant audience is not platform audience")
assert(fetches == 2 and last_response == "https://internal-iam/realms/tenant-a/protocol/openid-connect/certs")

reset()
assert(call({alg = "RS256", kid = "unknown"}, claims(tenant)) == 401)
assert(fetches == 1, "unknown kid must fetch JWKS and reject")

for _, failure in ipairs({
    {status = 503, body = "keys", reason = "non-200 JWKS"},
    {status = 200, body = string.rep("x", 65537), reason = "oversized JWKS"},
    {status = 200, body = "keys", keys = 33, reason = "too many JWKS keys"},
    {status = 200, body = "keys", keys = 0, reason = "empty JWKS"},
}) do
    reset()
    reply_status, reply_body = failure.status, failure.body
    if failure.keys then
        responses.keys = {keys = {}}
        for index = 1, failure.keys do responses.keys.keys[index] = valid_keys.keys[1] end
    end
    assert(call(header, claims(tenant)) == 401, failure.reason .. " must reject")
    assert(fetches == 1, failure.reason .. " must be fetched once")
end

reset()
conf.cache_max_entries = 1
assert(call(header, claims(platform)) == nil)
assert(call(header, claims(tenant)) == nil)
assert(call(header, claims(platform)) == nil and fetches == 3,
    "one-entry successful cache must evict the oldest valid realm")

for _, malformed in ipairs({false, 42, "invalid-key"}) do
    reset()
    responses.keys = {keys = {malformed}}
    assert(call(header, claims(tenant)) == 401, "malformed JWKS entry must reject without an error")
    assert(call(header, claims(tenant)) == 401 and fetches == 1,
        "malformed JWKS must use the bounded failure cache")
end

reset()
conf.cache_max_entries = 2
assert(call(header, claims(platform)) == nil)
assert(call(header, claims(tenant)) == nil)
fail_fetch = true
for index = 1, 20 do
    assert(call(header, claims("https://iam/realms/unknown-" .. index)) == 401)
end
assert(fetches == 10, "per-worker fetch burst must be bounded")
fail_fetch = false
local before = fetches
assert(call(header, claims(platform)) == nil and call(header, claims(tenant)) == nil)
assert(fetches == before, "failed realm flood must not evict valid JWKS")

reset()
assert(call(header, claims(platform)) == nil)
fail_fetch = true
assert(call(header, claims("https://iam/realms/unknown-1")) == 401)
assert(call(header, claims("https://iam/realms/unknown-2")) == 401)
assert(call(header, claims("https://iam/realms/unknown-1")) == 401 and fetches == 4,
    "failed entries must share the total cache bound without evicting valid keys")
assert(call(header, claims(platform)) == nil and fetches == 4)

reset()
assert(call(header, claims(platform)) == nil)
now = now + 11
fail_fetch = true
assert(call(header, claims(platform)) == 401, "expired keys must not be used after failed refresh")
fail_fetch = false
assert(call(header, claims(platform)) == 401 and fetches == 2,
    "failed refresh must be briefly cached")
now = now + 5
assert(call(header, claims(platform)) == nil and fetches == 3,
    "expired keys must be refreshed after the negative TTL")
print("issuer-jwks-auth unit tests passed")
