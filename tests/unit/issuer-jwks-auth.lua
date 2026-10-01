-- Run with Lua/LuaJIT from the repository root. APISIX dependencies are stubbed
-- so issuer selection, rejection and cache behavior can be checked offline.
local now = 1000
local fetches = 0
local decoded = {}
local responses = {}
local last_response
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
                return {status = 200, body = "keys"}
            end,
        }
    end}
end
package.preload["resty.jwt"] = function()
    return {verify = function(_, _, token)
        return {verified = token:match("%.good$") ~= nil}
    end}
end

local plugin = dofile("charts/in-falcone/files/apisix/plugins/issuer-jwks-auth.lua")
local platform = "https://iam/realms/platform"
local tenant = "https://iam/realms/tenant-a"
local unknown = "https://other/realms/tenant-a"
local conf = {issuer_base_url = "https://iam", jwks_base_url = "https://internal-iam",
    platform_realm = "platform", audience = "api", cache_ttl = 10, cache_max_entries = 1, timeout = 1}
responses.keys = {keys = {{kid = "key-1", kty = "RSA", x5c = {"Y2VydA=="}}}}

local function call(header, payload, signature)
    decoded["h==="] = "header"
    decoded["p==="] = "payload"
    responses.header = header
    responses.payload = payload
    local code = plugin.rewrite(conf, {authorization = "Bearer h.p." .. signature})
    return code
end

local function claims(iss)
    return {iss = iss, aud = "api", exp = now + 60}
end

assert(call({alg = "RS256", kid = "key-1"}, claims(platform), "good") == nil)
assert(fetches == 1 and last_response == "https://internal-iam/realms/platform/protocol/openid-connect/certs")
assert(call({alg = "RS256", kid = "key-1"}, claims(platform), "good") == nil)
assert(fetches == 1, "cached JWKS should avoid another fetch")
assert(call({alg = "RS256", kid = "key-1"}, claims(unknown), "good") == 401)
assert(fetches == 1, "unknown issuer must never cause a fetch")
for _, issuer in ipairs({"https://iam/realms/../other", "https://iam/realms/a%2Fb",
    "https://iam/realms/a/b", "https://iam/realms/a?b", "https://iam/realms/a#b"}) do
    assert(call({alg = "RS256", kid = "key-1"}, claims(issuer), "good") == 401)
end
assert(fetches == 1, "invalid realm must never cause a fetch")
assert(call({alg = "RS256", kid = "key-1"}, claims(platform), "bad") == 401)
assert(call({alg = "none", kid = "key-1"}, claims(platform), "good") == 401)
assert(call({alg = "HS256", kid = "key-1"}, claims(platform), "good") == 401)
local expired = claims(platform)
expired.exp = now - 1
assert(call({alg = "RS256", kid = "key-1"}, expired, "good") == 401)
local wrong_audience = claims(platform)
wrong_audience.aud = "other"
assert(call({alg = "RS256", kid = "key-1"}, wrong_audience, "good") == 401)
local tenant_other_audience = claims(tenant)
tenant_other_audience.aud = "tenant-client"
assert(call({alg = "RS256", kid = "key-1"}, tenant_other_audience, "good") == nil)
assert(fetches == 2 and last_response == "https://internal-iam/realms/tenant-a/protocol/openid-connect/certs")
assert(call({alg = "RS256", kid = "key-1"}, claims(platform), "good") == nil)
assert(fetches == 3, "one-entry cache should evict platform after tenant")
now = now + 11
fail_fetch = true
assert(call({alg = "RS256", kid = "key-1"}, claims(platform), "good") == 401)
fail_fetch = false
assert(call({alg = "RS256", kid = "key-1"}, claims(platform), "good") == 401)
assert(fetches == 4, "failed JWKS fetch should be briefly cached")
now = now + 5
assert(call({alg = "RS256", kid = "key-1"}, claims(platform), "good") == nil)
assert(fetches == 5, "expired JWKS must be refreshed and failed refresh must reject")
assert(call({alg = "RS256", kid = "key-1"}, claims(tenant), "good") == nil)
assert(fetches == 6, "negative entries must share the bounded LRU with valid JWKS")
print("issuer-jwks-auth unit tests passed")
