-- Route-local bearer verifier. The token selects only a realm under the
-- configured Keycloak base; it never selects the JWKS host.
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
        required = {"issuer_base_url", "jwks_base_url", "platform_realm", "audience", "cache_ttl", "cache_max_entries", "timeout"},
        properties = {
            issuer_base_url = {type = "string", pattern = "^https?://"},
            jwks_base_url = {type = "string", pattern = "^https?://"},
            platform_realm = {type = "string", minLength = 1},
            audience = {type = "string", minLength = 1},
            cache_ttl = {type = "integer", minimum = 1, maximum = 3600},
            cache_max_entries = {type = "integer", minimum = 1, maximum = 1024},
            timeout = {type = "integer", minimum = 1, maximum = 10},
        },
    },
}

-- Each APISIX worker holds at most cache_max_entries total cache entries.
-- Failed lookups use spare capacity and cannot evict valid tenant keys.
-- Expired keys are never used after a failed refresh.
local cache = {}
local count = 0
local failures = {}
local failure_count = 0
local failed_fetch_ttl = 5
-- A worker may burst ten fetches, refill five fetches per second, and hold
-- at most four fetches in flight. Cached keys remain usable during a flood.
local fetch_burst = 10
local fetch_rate = 5
local max_in_flight = 4
local fetch_tokens = fetch_burst
local fetch_updated = 0
local in_flight = 0

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

local function forget(cache_key)
    if cache[cache_key] then
        cache[cache_key] = nil
        count = count - 1
    end
end

local function remember_failure(conf, cache_key, now)
    forget(cache_key)
    local available = conf.cache_max_entries - count
    if available <= 0 then return end
    if not failures[cache_key] then
        while failure_count >= available do
            local oldest, expiry
            for issuer, item in pairs(failures) do
                if not expiry or item < expiry then
                    oldest, expiry = issuer, item
                end
            end
            failures[oldest] = nil
            failure_count = failure_count - 1
        end
        failure_count = failure_count + 1
    end
    failures[cache_key] = now + failed_fetch_ttl
end

local function remember(conf, cache_key, now, keys)
    if failures[cache_key] then
        failures[cache_key] = nil
        failure_count = failure_count - 1
    end
    local cached = cache[cache_key]
    -- A successful fetch takes spare capacity from failed lookups first.
    while failure_count + count + (cached and 0 or 1) > conf.cache_max_entries
        and failure_count > 0 do
        local oldest, expiry
        for issuer, item in pairs(failures) do
            if not expiry or item < expiry then
                oldest, expiry = issuer, item
            end
        end
        failures[oldest] = nil
        failure_count = failure_count - 1
    end
    local available = conf.cache_max_entries - (cached and 0 or 1)
    while count > available do
        local oldest, oldest_time
        for issuer, item in pairs(cache) do
            if issuer ~= cache_key and (not oldest_time or item.used < oldest_time) then
                oldest, oldest_time = issuer, item.used
            end
        end
        cache[oldest] = nil
        count = count - 1
    end
    if not cached then count = count + 1 end
    cache[cache_key] = {keys = keys, expires = now + conf.cache_ttl, used = now}
end

local function get_keys(conf, realm)
    local now = ngx.now()
    local cache_key = conf.jwks_base_url .. "/realms/" .. realm
    local cached = cache[cache_key]
    if cached and cached.expires > now then
        cached.used = now
        return cached.keys
    end
    if failures[cache_key] and failures[cache_key] > now then return nil end
    fetch_tokens = math.min(fetch_burst, fetch_tokens + math.max(0, now - fetch_updated) * fetch_rate)
    fetch_updated = now
    if fetch_tokens < 1 or in_flight >= max_in_flight then return nil end
    fetch_tokens = fetch_tokens - 1
    in_flight = in_flight + 1
    local ok, response = pcall(function()
        local client = http.new()
        client:set_timeout(conf.timeout * 1000)
        return client:request_uri(cache_key .. "/protocol/openid-connect/certs",
            {method = "GET", ssl_verify = true})
    end)
    in_flight = in_flight - 1
    if not ok or not response or response.status ~= 200
        or type(response.body) ~= "string" or #response.body > 65536 then
        remember_failure(conf, cache_key, now)
        return nil
    end
    local document = cjson.decode(response.body)
    if type(document) ~= "table" or type(document.keys) ~= "table"
        or #document.keys == 0 or #document.keys > 32 then
        remember_failure(conf, cache_key, now)
        return nil
    end
    for _, key in ipairs(document.keys) do
        if type(key) ~= "table" then
            remember_failure(conf, cache_key, now)
            return nil
        end
    end
    remember(conf, cache_key, now, document.keys)
    return document.keys
end

local function allowed_audience(aud, expected)
    if aud == expected then return true end
    if type(aud) == "table" then
        for _, actual in ipairs(aud) do if actual == expected then return true end end
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
    local prefix = conf.issuer_base_url .. "/realms/"
    local realm = type(payload.iss) == "string" and payload.iss:sub(1, #prefix) == prefix
        and payload.iss:sub(#prefix + 1) or nil
    if not realm or #realm == 0 or #realm > 128 or not realm:match("^[A-Za-z0-9_-]+$")
        or type(payload.exp) ~= "number" or payload.exp <= ngx.time()
        or (payload.nbf ~= nil and (type(payload.nbf) ~= "number" or payload.nbf > ngx.time()))
        or (realm == conf.platform_realm and not allowed_audience(payload.aud, conf.audience)) then
        return 401, {message = "Unauthorized"}
    end
    local keys = get_keys(conf, realm)
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
