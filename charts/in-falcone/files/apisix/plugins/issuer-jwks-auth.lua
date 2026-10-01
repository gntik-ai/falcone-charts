-- Route-local bearer verifier. Issuer URLs and JWKS endpoints come only from
-- rendered realm configuration, never from an unverified token.
local core = require("apisix.core")
local cjson = require("cjson.safe")
local http = require("resty.http")
local jwt = require("resty.jwt")

local plugin = {
    version = 0.1,
    -- CORS preflight runs first (4000); authenticate before request-validation
    -- (2800) so missing credentials receive 401 even without policy headers.
    priority = 3500,
    name = "issuer-jwks-auth",
    schema = {
        type = "object",
        required = {"issuers", "cache_ttl", "cache_max_entries", "timeout"},
        properties = {
            issuers = {type = "array", minItems = 1, items = {
                type = "object", required = {"issuer", "jwks_uri", "audiences"},
                properties = {
                    issuer = {type = "string", minLength = 1},
                    jwks_uri = {type = "string", pattern = "^https?://"},
                    audiences = {type = "array", minItems = 1, items = {type = "string"}},
                },
            }},
            cache_ttl = {type = "integer", minimum = 1, maximum = 3600},
            cache_max_entries = {type = "integer", minimum = 1, maximum = 1024},
            timeout = {type = "integer", minimum = 1, maximum = 10},
        },
    },
}

-- Each APISIX worker holds at most cache_max_entries JWKS documents. Expired
-- entries are never used if a refresh fails. Unknown issuers do not reach HTTP.
local cache = {}
local count = 0

local function b64url(value)
    if type(value) ~= "string" or not value:match("^[A-Za-z0-9_-]+$") then return nil end
    return ngx.decode_base64(value:gsub("-", "+"):gsub("_", "/") .. string.rep("=", (4 - #value % 4) % 4))
end

local function der_length(length)
    if length < 128 then return string.char(length) end
    if length < 256 then return string.char(0x81, length) end
    return string.char(0x82, math.floor(length / 256), length % 256)
end

local function der(tag, bytes)
    return string.char(tag) .. der_length(#bytes) .. bytes
end

local function rsa_pem(key)
    if type(key.x5c) == "table" and type(key.x5c[1]) == "string" then
        local cert = key.x5c[1]
        if not cert:match("^[A-Za-z0-9+/=]+$") then return nil end
        return "-----BEGIN CERTIFICATE-----\n" .. cert .. "\n-----END CERTIFICATE-----"
    end
    local n, e = b64url(key.n), b64url(key.e)
    if not n or not e or #n < 256 or #e == 0 then return nil end
    if n:byte(1) >= 128 then n = "\0" .. n end
    if e:byte(1) >= 128 then e = "\0" .. e end
    local rsa = der(0x30, der(0x02, n) .. der(0x02, e))
    local algorithm = string.char(0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48,
        0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00)
    local spki = der(0x30, algorithm .. der(0x03, "\0" .. rsa))
    local encoded = ngx.encode_base64(spki)
    return "-----BEGIN PUBLIC KEY-----\n" .. encoded .. "\n-----END PUBLIC KEY-----"
end

local function get_keys(conf, entry)
    local now = ngx.now()
    local cached = cache[entry.issuer]
    if cached and cached.expires > now then
        cached.used = now
        return cached.keys
    end
    local client = http.new()
    client:set_timeout(conf.timeout * 1000)
    local ok, response = pcall(client.request_uri, client, entry.jwks_uri, {method = "GET", ssl_verify = true})
    if not ok or not response or response.status ~= 200
        or type(response.body) ~= "string" or #response.body > 65536 then return nil end
    local document = cjson.decode(response.body)
    if type(document) ~= "table" or type(document.keys) ~= "table" or #document.keys > 32 then return nil end
    while not cached and count >= conf.cache_max_entries do
        local oldest, oldest_time
        for issuer, item in pairs(cache) do
            if not oldest_time or item.used < oldest_time then oldest, oldest_time = issuer, item.used end
        end
        cache[oldest] = nil
        count = count - 1
    end
    if not cached then count = count + 1 end
    cache[entry.issuer] = {keys = document.keys, expires = now + conf.cache_ttl, used = now}
    return document.keys
end

local function allowed_audience(aud, expected)
    for _, value in ipairs(expected) do
        if aud == value then return true end
        if type(aud) == "table" then
            for _, actual in ipairs(aud) do if actual == value then return true end end
        end
    end
    return false
end

function plugin.check_schema(conf)
    return core.schema.check(plugin.schema, conf)
end

function plugin.rewrite(conf, ctx)
    local authorization = core.request.header(ctx, "Authorization")
    local token = type(authorization) == "string" and authorization:match("^Bearer ([A-Za-z0-9_.-]+)$")
    if not token or #token > 16384 then return 401, {message = "Unauthorized"} end
    local header, payload = token:match("^([^.]+)%.([^.]+)%.[^.]+$")
    header = header and cjson.decode(b64url(header) or "")
    payload = payload and cjson.decode(b64url(payload) or "")
    if type(header) ~= "table" or type(payload) ~= "table"
        or not ({RS256 = true, RS384 = true, RS512 = true})[header.alg]
        or type(header.kid) ~= "string" or #header.kid > 256 then
        return 401, {message = "Unauthorized"}
    end
    local entry
    for _, candidate in ipairs(conf.issuers) do
        if payload.iss == candidate.issuer then entry = candidate; break end
    end
    if not entry or type(payload.exp) ~= "number" or payload.exp <= ngx.time()
        or (payload.nbf ~= nil and (type(payload.nbf) ~= "number" or payload.nbf > ngx.time()))
        or not allowed_audience(payload.aud, entry.audiences) then
        return 401, {message = "Unauthorized"}
    end
    local keys = get_keys(conf, entry)
    if not keys then return 401, {message = "Unauthorized"} end
    for _, key in ipairs(keys) do
        if key.kty == "RSA" and key.kid == header.kid
            and (key.use == nil or key.use == "sig")
            and (key.alg == nil or key.alg == header.alg) then
            local pem = rsa_pem(key)
            if pem then
                local ok, verified = pcall(jwt.verify, jwt, pem, token)
                if ok and verified and verified.verified then return end
            end
        end
    end
    return 401, {message = "Unauthorized"}
end

return plugin
