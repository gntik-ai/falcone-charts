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
local platform = {issuer = "https://iam/realms/platform", jwks_uri = "https://iam/realms/platform/certs", audiences = {"api"}}
local tenant = {issuer = "https://iam/realms/tenant-a", jwks_uri = "https://iam/realms/tenant-a/certs", audiences = {"api"}}
local unknown = {issuer = "https://other/realms/tenant-a", jwks_uri = "https://other/certs", audiences = {"api"}}
local conf = {issuers = {platform, tenant}, cache_ttl = 10, cache_max_entries = 1, timeout = 1}
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

assert(call({alg = "RS256", kid = "key-1"}, claims(platform.issuer), "good") == nil)
assert(fetches == 1 and last_response == platform.jwks_uri)
assert(call({alg = "RS256", kid = "key-1"}, claims(platform.issuer), "good") == nil)
assert(fetches == 1, "cached JWKS should avoid another fetch")
assert(call({alg = "RS256", kid = "key-1"}, claims(unknown.issuer), "good") == 401)
assert(fetches == 1, "unknown issuer must never cause a fetch")
assert(call({alg = "RS256", kid = "key-1"}, claims(platform.issuer), "bad") == 401)
assert(call({alg = "none", kid = "key-1"}, claims(platform.issuer), "good") == 401)
assert(call({alg = "HS256", kid = "key-1"}, claims(platform.issuer), "good") == 401)
local expired = claims(platform.issuer)
expired.exp = now - 1
assert(call({alg = "RS256", kid = "key-1"}, expired, "good") == 401)
local wrong_audience = claims(platform.issuer)
wrong_audience.aud = "other"
assert(call({alg = "RS256", kid = "key-1"}, wrong_audience, "good") == 401)
assert(call({alg = "RS256", kid = "key-1"}, claims(tenant.issuer), "good") == nil)
assert(fetches == 2 and last_response == tenant.jwks_uri)
assert(call({alg = "RS256", kid = "key-1"}, claims(platform.issuer), "good") == nil)
assert(fetches == 3, "one-entry cache should evict platform after tenant")
now = now + 11
fail_fetch = true
assert(call({alg = "RS256", kid = "key-1"}, claims(platform.issuer), "good") == 401)
fail_fetch = false
assert(call({alg = "RS256", kid = "key-1"}, claims(platform.issuer), "good") == nil)
assert(fetches == 5, "expired JWKS must be refreshed and failed refresh must reject")
print("issuer-jwks-auth unit tests passed")
