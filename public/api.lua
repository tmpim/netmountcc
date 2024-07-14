local expect = require("cc.expect")

-- [[ Utility functions ]] --
local b64e
do
    -- Lua 5.1+ base64 v3.0 (c) 2009 by Alex Kloss <alexthkloss@web.de>
    -- licensed under the terms of the LGPL2

    -- character table string
    local b = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    -- encoding
    function b64e(data)
        local yield = 50000
        local sum = 0
        return ((data:gsub('.', function(x)
            local r, c = '', x:byte()
            sum = sum + 1
            if sum > yield then
                sleep()
                sum = 0
            end
            for i = 8, 1, -1 do r = r .. (c % 2 ^ i - c % 2 ^ (i - 1) > 0 and '1' or '0') end
            return r;
        end) .. '0000'):gsub('%d%d%d?%d?%d?%d?', function(x)
            if (#x < 6) then return '' end
            local c = 0
            sum = sum + 1
            if sum > yield then
                sleep()
                sum = 0
            end
            for i = 1, 6 do c = c + (x:sub(i, i) == '1' and 2 ^ (6 - i) or 0) end
            return b:sub(c + 1, c + 1)
        end) .. ({ '', '==', '=' })[#data % 3 + 1])
    end
end

local v4
do
    local dashes = {
        [8] = true,
        [12] = true,
        [16] = true,
        [20] = true
    }
    function v4()
        local out = {}
        for i = 1, 32 do
            --[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}
            local val
            if i == 13 then
                val = 4
            elseif i == 17 then
                val = math.random(8, 11)
            else
                val = math.random(0, 15)
            end
            if val < 10 then
                out[#out + 1] = val
            else
                out[#out + 1] = string.char(val + 87)
            end
            if dashes[i] then
                out[#out + 1] = "-"
            end
        end
        return table.concat(out, "")
    end
end

local unserializeJSON, unserializeStream
do
    local patterns = {
        "^[0] ([0-9a-fA-F-]+) (%d+) (.*)$",
        "^[1] ([0-9a-fA-F-]+) (%d+)$",
        "^[2] ([0-9a-fA-F-]+) (%d+)$",
        "^[3] ([0-9a-fA-F-]+) (.*)$",
        "^[4] ([0-9a-fA-F-]+) (.*)$",
    }

    function unserializeStream(str)
        local out
        -- 0 uuid chunk# [data] - Transmit data
        -- 1 uuid chunk# - Request chunk
        -- 2 uuid chunk# - Flag chunk as received
        -- 3 uuid reason - End write stream, failed
        -- 4 uuid attrs - End write stream, success
        local method = tonumber(str:sub(1, 1))
        if method == 0 then
            str:gsub(patterns[1], function(uuid, chunk, data)
                out = {
                    uuid = uuid,
                    chunk = tonumber(chunk),
                    data = data,
                }
            end)
        elseif method == 1 then
            str:gsub(patterns[2], function(uuid, chunk)
                out = {
                    uuid = uuid,
                    chunk = tonumber(chunk)
                }
            end)
        elseif method == 2 then
            str:gsub(patterns[3], function(uuid, chunk)
                out = {
                    uuid = uuid,
                    chunk = tonumber(chunk),
                    success = true
                }
            end)
        elseif method == 3 then
            str:gsub(patterns[4], function(uuid, reason)
                out = {
                    ok = false,
                    uuid = uuid,
                    err = reason
                }
            end)
        elseif method == 4 then
            str:gsub(patterns[5], function(uuid, json)
                out = {
                    ok = true,
                    uuid = uuid,
                    data = unserializeJSON(json)
                }
            end)
        end
        if out and out.uuid then
            return out
        end
    end

    function unserializeJSON(str)
        local ok, data = pcall(textutils.unserialiseJSON, str)
        if ok then
            return data
        end
    end
end

local function waitForAllSafe(...)
    local tt = {}
    for k, v in pairs(table.pack(...)) do
        local tmax = #tt + 1
        if type(v) == "function" then
            tt[tmax] = v
        end
        if tmax % 128 == 0 then
            parallel.waitForAll(table.unpack(tt))
            tt = {}
        end
    end
    parallel.waitForAll(table.unpack(tt))
end

-- [[ Websocket Request/Response Functions ]] --
local chunkSize, chunkTimeout = (2^16)-10, 3600*20*10

local function createServerConnection(ws, url)
    --- Gets a basic response from the server determined by the given request.
    ---@param data table
    ---@param timeout integer?
    ---@param noSend boolean?
    ---@return boolean
    ---@return string|table
    local function request(data, timeout, noSend)
        assert(data.type, "Missing request type")
        if not noSend then
            ws.send(textutils.serializeJSON(data))
        end
        local reqres
        parallel.waitForAny(function()
            sleep(timeout or 5)
        end, function()
            while true do
                local e, wsurl, response = os.pullEventRaw()
                if e == "websocket_message" and wsurl == url and response then
                    local json = unserializeJSON(response)
                    if json and json.type == data.type then
                        reqres = json
                        return
                    end
                elseif e == "websocket_closed" and wsurl == url then
                    reqres = {
                        ok = false,
                        err = response
                    }
                    return
                end
            end
        end)
        if not reqres then
            return false, "Timeout"
        elseif reqres.ok then
            return true, reqres.data
        else
            return false, reqres.err
        end
    end

    local function handleStream(chunks, totalChunks, func)
        local threads = {}
        local lastChunk, attempts, errors = os.epoch(), 0, {}
        -- 3 request attempts, retries if no chunks are sent in a 5 second interval
        while #chunks < totalChunks do
            for chunk = 0, totalChunks - 1 do
                threads[chunk + 1] = function()
                    while not chunks[chunk + 1] do
                        local s, e = func(chunk)
                        if not s then
                            errors[#errors+1] = "Chunk "..tostring(chunk).." "..(tostring(e) or "Unknown error occured")
                            return
                        end
                    end
                    lastChunk = os.epoch()
                end
            end

            attempts = attempts + 1

            parallel.waitForAny(function()
                while os.epoch() < lastChunk + chunkTimeout do
                    sleep(1)
                end
                lastChunk = os.epoch()
            end, function()
                waitForAllSafe(table.unpack(threads))
            end)

            if attempts == 3 then
                return false, "Attempt limit reached", errors
            else
                return true
            end
        end

    end

    local function streamListen(uuid, chunk, func)
        while true do
            local e, wsurl, rawdata = os.pullEventRaw()
            if e == "websocket_message" and wsurl == url then
                local response = unserializeStream(rawdata)
                if response and response.uuid == uuid and response.chunk == chunk then
                    return func(response)
                end
            elseif e == "websocket_close" and wsurl == url then
                return false, "Websocket Closed"
            end
        end
    end

    local function readStream(req, noSend)
        local ok, data = request(req, nil, noSend)
        if not ok then
            return false, data
        elseif not data.uuid then
            return false, "Missing stream UUID"
        elseif not data.chunks then
            return false, "Missing chunk total"
        else
            local chunks = {}
            local suc, err, errs = handleStream(chunks, data.chunks, function(chunk)
                local header = " " .. data.uuid .. " " .. chunk
                ws.send("1" .. header, true)
                return streamListen(data.uuid, chunk, function(response)
                    chunks[chunk + 1] = response.data
                    ws.send("2" .. header, true)
                    lastChunk = os.epoch()
                    return true
                end)
            end)
            if suc then
                return true, table.concat(chunks)
            else
                errs = errs or {}
                return false, "Read stream error, "..(err or "Reason unknown")..":\n"..table.concat(errs, "\n", 1, math.min(#errs, 5))
            end
        end
    end

    local function writeStream(req, contents)
        req.uuid = v4()
        req.chunks = math.max(math.ceil(#contents / chunkSize), 1)
        local ok, data = request(req)
        local chunks = {}
        local suc, err, errs = handleStream(chunks, req.chunks, function(chunk)
            local schunk = contents:sub((chunkSize * chunk) + 1, (chunkSize * (chunk + 1)))
            ws.send(table.concat({ "0", req.uuid, chunk, schunk }, " "), true)
            return streamListen(req.uuid, chunk, function(response)
                if response.success then
                    chunks[chunk + 1] = true
                    return true
                elseif response.err then
                    return false, response.err
                end
            end)
        end)
        if suc then
            return streamListen(req.uuid, nil, function(response)
                return response.ok, response.err or response.data
            end)
        else
            err = (err or "Reason unknown")
            ws.send("3 " .. req.uuid .. " " .. err, true)
            -- Could error check send at this point, but we've already errored...
            error("Write stream error, "..err..":\n"..table.concat(errs or {}, "\n", 1, 5))
        end
    end

    return {
        request = request,
        readStream = readStream,
        writeStream = writeStream
    }
end

-- [[ Main API ]] --

---@class NetMountAPI
local nm = {}

--- Create a netmount connection state. Attempts connection once, returns the state object if successful, or false and an error string if not.
---@param url string
---@param username string
---@param password string
---@return false|NetmountState
---@return string?
nm.createState = function(url, username, password)
    expect(1, url, "string")
    expect(2, username, "string")
    expect(3, password, "string")
    local credentials = { -- Basic Credentials object
        username = username,
        auth = { Authorization = "Basic " .. b64e(username .. ":" .. password) }
    }
    -- Reserve a session UUID
    url = url:gsub("/?$", "/")
    local uidh = assert(http.get(url .. "api/reserve/ws", credentials.auth))
    local uid = assert(unserializeJSON(uidh.readAll()), "UUID Reserve: Failed to parse JSON")
    uidh.close()
    assert(uid.ok, uid.err)
    credentials.url = url:gsub("^http", "ws")..uid.uuid -- Set the credentials URL
    http.websocketAsync(credentials.url, credentials.auth) -- Use it to log in
    while true do
        local eventData = { os.pullEventRaw() }
        local event, wsurl = table.remove(eventData, 1), table.remove(eventData, 1)
        if event == "websocket_success" and wsurl == credentials.url then
            local ws = table.remove(eventData, 1)
            local server = createServerConnection(ws, credentials.url)

            local ok, syncDataU = server.readStream({
                ok = true,
                type = "hello"
            }, true)
            local syncData = unserializeJSON(syncDataU)
            if ok and not syncData then
                error("Hello Stream: Failed to parse JSON")
            elseif not ok then
                error(syncDataU)
            end

            local state = {
                server = server,
                attributes = syncData,
                credentials = credentials,
                close = ws.close
            }
            return state
        elseif event == "websocket_closed" and wsurl == credentials.url then
            return false, "Connection closed"
        elseif event == "websocket_failure" and wsurl == credentials.url then
            return false, (eventData[1] or "Unknown reason")
        end
    end
end

--- Get a sync handler function for the given state.
--- This handler MUST be run in parallel to any other functions or programs that will be utilizing netmount.
--- Additionally it MUST be run immediately after the connection has been established in order not to miss any file sync events
---@param state NetmountState
---@return function
nm.getSyncHandler = function(state)
    expect(1, state, "table")
    return function()
        while true do
            local e, wsurl, sres = os.pullEventRaw("websocket_message")
            if wsurl == state.credentials.url and sres then
                local json = unserializeJSON(sres)
                if json and json.type == "sync" and json.data and state.attributes then
                    state.attributes.contents[json.data.path] = json.data.attributes or nil
                    state.attributes.capacity = json.data.capacity
                end
            end
        end
    end
end

--- Get a connection handler for the given state.
--- This is can optionally be put in parallel with your program and the sync handler
--- Will attempt to reconnect with the netmount server after a disconnect, repairing the state object in the process.
--- If the connection fails maxAttempts times in a row (default: 3), the connection handler errors. Set to 0 to disable.
---@param state NetmountState
---@param maxAttempts integer
---@return function
nm.getConnectionHandler = function(state, maxAttempts)
    expect(1, state, "table")
    maxAttempts = maxAttempts or 3
    local attempts = 0
    return function ()
        while true do
            local eventData = { os.pullEventRaw() }
            local event, wsurl = table.remove(eventData, 1), table.remove(eventData, 1)
            if event == "websocket_success" and wsurl == state.credentials.url then
                attempts = 0
                local ws = table.remove(eventData, 1)
                local server = createServerConnection(ws)
                local ok, syncDataU = server.readStream({
                    ok = true,
                    type = "hello"
                }, true)
                local attributes = unserializeJSON(syncDataU)
                if not attributes or not ok then
                    attempts = attempts + 1
                end
                state.server = server
                state.attributes = attributes
                state.close = ws.close
            elseif event == "websocket_closed" and wsurl == state.credentials.url then
                attempts = attempts + 1
                if attempts == maxAttempts then
                    error("Socket connection failed after"..tostring(maxAttempts).."attempts")
                else
                    sleep(2)
                    http.websocketAsync(state.credentials.url, state.credentials.auth)
                end
            elseif event == "websocket_failure" and wsurl == state.credentials.url then
                attempts = attempts + 1
            end
        end
    end
end

--- Create a file system-like API for the given state.
---@param state NetmountState
---@param mount string Vanity mount name for errors. Changes nothing functionally about input paths
---@param streamHandlers boolean? Enable advanced stream handlers, allowing for more efficient transfer of streamed content like dfpwm.
---@return table
nm.createFs = function(state, mount, streamHandlers)
    expect(1, state, "table")
    mount = ""

    local api = {}

    local function getAttributes(path)
        return state.attributes.contents[path]
    end

    local function prefix(path, err)
        local out = fs.combine(mount, path)
        if err then
            return err:gsub(path, out)
        else
            return out
        end
    end

    -- [[ Functions that can be directly ripped from old fs API ]] --
    local copyold = {
        "combine",
        "getName",
        "getDir",
    }

    for _, fn in ipairs(copyold) do
        api[fn] = fs[fn]
    end

    -- [[ Overrides ]] --

    api.list = function(path)
        expect(1, path, "string")
        path = fs.combine(path)
        local attrs = state.attributes.contents[path]
        if attrs and attrs.isDir then
            local out = {}
            for fullpath in pairs(state.attributes.contents) do
                local dir = api.getDir(fullpath)
                if dir == path then
                    out[#out + 1] = api.getName(fullpath)
                end
            end
            return out
        else
            error(prefix(path) .. ": Not a directory")
        end
    end

    api.attributes = function(path)
        expect(1, path, "string")
        path = fs.combine(path)
        local attributes = getAttributes(path)
        if attributes then
            return attributes
        else
            error(prefix(path) .. ": No such file")
        end
    end

    api.exists = function(path)
        expect(1, path, "string")
        path = fs.combine(path)
        return getAttributes(path) and true or false
    end

    api.isDir = function(path)
        expect(1, path, "string")
        path = fs.combine(path)
        local attributes = getAttributes(path)
        return (attributes and attributes.isDir) and true or false
    end

    api.isReadOnly = function(path)
        expect(1, path, "string")
        path = fs.combine(path)
        local attributes = getAttributes(path)
        return (attributes and attributes.isReadOnly) and true or false
    end

    api.getDrive = function(path)
        expect(1, path, "string")
        path = fs.combine(path)
        if api.exists(path) then
            return "netmount"
        else
            return nil
        end
    end

    api.getSize = function(path)
        expect(1, path, "string")
        path = fs.combine(path)
        local attributes = getAttributes(path)
        if attributes then
            return attributes.size
        else
            error(prefix(path) .. ": No such file ")
        end
    end

    api.getFreeSpace = function(path)
        expect(1, path, "string")
        path = fs.combine(path)
        return state.attributes.capacity[1]
    end

    api.getCapacity = function(path)
        expect(1, path, "string")
        path = fs.combine(path)
        return state.attributes.capacity[2]
    end

    -- [[ Network Dependent Overrides ]] --

    local singleOverrides = {
        "makeDir",
        "delete"
    }

    for _, name in ipairs(singleOverrides) do
        api[name] = function(path)
            expect(1, path, "string")
            path = fs.combine(path)
            local ok, err = state.server.request({
                type = name,
                path = path
            })
            if ok then
                state.attributes.contents[err.path] = err.attributes or nil
            else
                error(prefix(path, err))
            end
        end
    end

    local doubleOverrides = {
        "move",
        "copy"
    }

    for _, name in ipairs(doubleOverrides) do
        local function relocate(path, dest)
            expect(1, path, "string")
            expect(2, dest, "string")
            path, dest = fs.combine(path), fs.combine(dest)
            if api.exists(dest) then
                error("/".. fs.combine(mount, path) ..": File exists")
            end
            local ok, err = state.server.request({
                type = name,
                path = path,
                dest = dest
            })
            if ok then
                state.attributes.contents[err.path] = err.attributes or nil
            else
                error(prefix(path, prefix(dest, err)))
            end
        end

        api[name] = function(path, dest)
            local func, p = relocate(path, dest)
            if func then
                func(p)
            end
        end
    end

    -- [[ Network Dependent File Handles ]] --
    local genericHandle, writeHandle, readHandle
    if streamHandlers then

    else
        function genericHandle(path, binary)
            local internal = {
                buffer = "",
                pos = 0,
                closed = false
            }
            local handle = {}

            if binary then
                handle.seek = function(whence, offset)
                    assert(not internal.closed, "attempt to use a closed file")
                    if not offset then
                        offset = 0
                    end
                    if whence == "set" then
                        internal.pos = offset
                    elseif whence == "end" then
                        internal.pos = #internal.buffer + offset
                    else
                        internal.pos = internal.pos + offset
                    end
                    if internal.pos < 0 then
                        internal.pos = 0
                        return nil, "Position is negative"
                    end
                    return internal.pos
                end
            end

            handle.close = function()
                assert(not internal.closed, "attempt to use a closed file")
                internal.closed = true
            end

            return handle, internal
        end

        function writeHandle(path, binary, append)
            local handle, internal = genericHandle(path, binary)
            if append then
                local ok, data = state.server.readStream({
                    ok = true,
                    type = "readFile",
                    path = path
                })
                if ok then
                    internal.buffer = data
                    internal.ibuffer = data
                    internal.pos = #data
                else
                    error("Read stream error: " .. data)
                end
            end

            handle.write = function(text)
                assert(not internal.closed, "attempt to use a closed file")
                if type(text) == "table" then
                    text = string.char(table.unpack(text))
                end
                internal.buffer = internal.buffer:sub(0, internal.pos) ..
                text .. internal.buffer:sub(internal.pos + #text + 1, -1)
                internal.pos = internal.pos + #text
            end

            handle.flush = function()
                assert(not internal.closed, "attempt to use a closed file")
                if internal.ibuffer ~= internal.buffer then
                    internal.ibuffer = internal.buffer
                    local out = internal.buffer:gsub("\n$", "")
                    local ok, data = state.server.writeStream({
                        ok = true,
                        type = "writeFile",
                        path = path,
                    }, out)
                    if ok then
                        state.attributes.contents[data.path] = data.attributes
                    else
                        error("Write stream error: " .. (data or "Unknown"))
                    end
                end
            end

            handle.close = function()
                assert(not internal.closed, "attempt to use a closed file")
                handle.flush()
                internal.closed = true
            end

            if not binary then
                handle.writeLine = function(text)
                    handle.write(text .. "\n")
                end
            end

            return handle
        end

        function readHandle(path, binary)
            local handle, internal = genericHandle(path, binary)
            local ok, data = state.server.readStream({
                ok = true,
                type = "readFile",
                path = path
            })
            if ok then
                internal.buffer = data
            else
                error("Read stream error: "..data)
            end

            handle.read = function(count)
                assert(not internal.closed, "attempt to use a closed file")
                local out = internal.buffer:sub(internal.pos+1, internal.pos+count)
                if internal.pos < #internal.buffer then
                    internal.pos = internal.pos + #out
                    return out
                end
            end

            handle.readLine = function(withTrailing)
                assert(not internal.closed, "attempt to use a closed file")
                local pos = internal.pos + 1
                local nl = internal.buffer:sub(pos, -1):find("\n")
                local out = internal.buffer:sub(pos, pos + (nl or #internal.buffer + 2) - (withTrailing and 1 or 2))
                local offset = #out + (withTrailing and 0 or 1)
                if internal.pos <= #internal.buffer then
                    internal.pos = internal.pos + offset
                    return out
                end
            end

            handle.readAll = function()
                assert(not internal.closed, "attempt to use a closed file")
                local pos = internal.pos + 1
                local out = internal.buffer:sub(pos, -1)
                if internal.pos < #internal.buffer then
                    internal.pos = internal.pos + #out
                    return out
                end
            end

            return handle
        end
    end


    api.open = function(path, mode)
        expect(1, path, "string")
        path = fs.combine(path)
        local b = mode:sub(2, 2)
        local binary = b == "b"
        if #mode > 2 and (b and not binary) then
            error("Unsupported mode")
        end
        local left = mode:sub(1, 1)
        if left == "w" then
            return writeHandle(path, binary)
        elseif left == "r" then
            return readHandle(path, binary)
        elseif left == "a" then
            return writeHandle(path, binary, true)
        else
            error("Unsupported mode")
        end
    end

    do -- Hack fs API definition to use our custom API.
        local romfs, i = "", 1
        for line in io.lines("rom/apis/fs.lua") do
            -- Rip out definition weirdness
            if not (i > 9 and i < 14) then
                romfs = romfs .. line .. "\n"
            end
            i = i + 1
        end
        local env = {}
        for k, f in pairs(_ENV) do
            if f == _ENV then
                f = env
            end
            env[k] = f
        end
        env.fs = api
        setmetatable(env, {__index = _G})

        assert(pcall(assert(load(romfs, "romfsapi", nil, env))))
    end

    return api
end

return nm