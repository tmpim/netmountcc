local ofs = assert(_G.fs, "-eh?")

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
            local val = math.random(0, 15)
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

-- [[ Argument Parsing ]] --
local args = table.pack(...)

local url, auth
do
    for i = 1, #args do
        args[i]:gsub("(.*)=(.*)", function(k, v)
            args[k] = v
        end)
    end
    if #args < 3 then
        local keys = {
            "url",
            "username",
            "password",
            "path",
            "run"
        }
        for i = 1, #keys do
            local key = keys[i]
            if not args[key] then
                args[key] = settings.get("netmount."..key)
            end
        end
    end
    if not (args.username and args.url) then
        print("Usage: mount [url=<url>] [username=<username>] [password=<password>] [path=<path>] [run=<program>]")
        print("Or, save url, username and password using set. Ex:")
        print("set netmount.url https://netmount.example.com")
        print("setting keys are netmount.url, netmount.username, netmount.password, and netmount.path")
        return
    end
    auth = { Authorization = "Basic " .. b64e(args.username .. ":" .. args.password) }
    url = args.url:gsub("^http", "ws")
end

local netroot = fs.combine(args.path or "net")
assert(not ofs.exists(netroot), "Directory "..netroot.." already exists")

local function toNetRoot(path)
    path = ofs.combine(path)
    local nreplaced
    path, nreplaced = path:gsub("^" .. netroot .. "/", "")
    if path == netroot then
        return true, ""
    elseif path == netroot or nreplaced == 1 then
        return true, path
    else
        return false, path
    end
end

-- [[ Websocket Request/Response Function & Netmount fs Initialization ]] --
local chunkSize, chunkTimeout = (2^16)-10, 3600*20*10

local function createNetutils(ws)
    local function request(data, timeout, noSend)
        assert(data.type, "Missing request type")
        if not noSend then
            local ok = ws.send(textutils.serializeJSON(data))
            if not ok then
                return false, "Request: Connection Interrupted"
            end
        end
        local reqres
        parallel.waitForAny(function()
            sleep(timeout or 5)
        end, function()
            while true do
                local _, wsurl, response = os.pullEventRaw("websocket_message")
                if wsurl == url and response then
                    local json = unserializeJSON(response)
                    if json and json.type == data.type then
                        reqres = json
                        return
                    end
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
        local lastChunk, attempts, lastErr = os.epoch(), 0, "Unknown"
        -- 3 request attempts, retries if no chunks are sent in a 5 seconds interval
        while #chunks < totalChunks and attempts < 3 do
            for chunk = 0, totalChunks - 1 do
                threads[chunk + 1] = function()
                    while not chunks[chunk + 1] do
                        local s, e = func(chunk)
                        if not s then
                            lastErr = e
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
        end

        if attempts == 3 then
            return false, "Attempt limit reached: "..lastErr
        else
            return true
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
            return false, "Missing chunk totals"
        else
            local chunks = {}
            local suc, err = handleStream(chunks, data.chunks, function(chunk)
                local header = " " .. data.uuid .. " " .. chunk
                local ok1 = ws.send("1" .. header, true)
                if not ok1 then
                    return false, "Chunk Request: Connection Interrupted"
                end
                return streamListen(data.uuid, chunk, function(response)
                    chunks[chunk + 1] = response.data
                    local ok2 = ws.send("2" .. header, true)
                    if not ok2 then
                        return false, "Chunk Confirm: Connection Interrupted"
                    end
                    lastChunk = os.epoch()
                    return true
                end)
            end)
            if suc then
                return true, table.concat(chunks)
            else
                error("Read stream error: "..(err or "Reason unknown"))
            end
        end
    end

    local function writeStream(req, contents)
        req.uuid = v4()
        req.chunks = math.max(math.ceil(#contents / chunkSize), 1)
        local ok, data = request(req)
        local chunks = {}
        local suc, err = handleStream(chunks, req.chunks, function(chunk)
            streamListen(req.uuid, chunk, function(res)
                local schunk = contents:sub((chunkSize * chunk) + 1, (chunkSize * (chunk + 1)))
                local ok1 = ws.send(table.concat({ "0", req.uuid, chunk, schunk }, " "), true)
                if not ok1 then
                    return false, "Chunk Send: Connection Interrupted"
                end
                streamListen(req.uuid, chunk, function(response)
                    if response.success then
                        chunks[chunk + 1] = true
                        return true
                    elseif response.err then
                        return false, response.err
                    end
                end)
            end)
            return true
        end)
        if suc then
            return streamListen(req.uuid, nil, function(response)
                return response.ok, response.err or response.data
            end)
        else
            err = (err or "Reason unknown")
            ws.send("3 " .. uuid .. " " .. err, true)
            -- Could error check send at this point, but we've already errored...
            pcall(ws.close)
            error("Write stream error: " .. err)
        end
    end

    return {
        request = request,
        readStream = readStream,
        writeStream = writeStream
    }
end

local function initfs(netutils, syncData)

    local fs = {}

    local function getAttributes(path)
        return syncData.contents[path]
    end

    local function isDriveRoot(path)
        if toNetRoot(path) then
            if #path == 0 then
                return true
            else
                return false
            end
        else
            return ofs.isDriveRoot(path)
        end
    end

    -- [[ Functions that can be directly ripped from old fs API ]] --
    local copyold = {
        "combine",
        "getName",
        "getDir",
    }

    for _, fn in ipairs(copyold) do
        fs[fn] = ofs[fn]
    end

    -- [[ Overrides ]] --

    fs.list = function(path)
        local net
        net, path = toNetRoot(path)
        if net then
            local attrs = syncData.contents[path]
            if attrs and attrs.isDir then
                local out = {}
                for fullpath in pairs(syncData.contents) do
                    local dir = fs.getDir(fullpath)
                    if dir == path then
                        out[#out + 1] = fs.getName(fullpath)
                    end
                end
                return out
            else
                error(fs.combine(netroot, path)..": Not a directory")
            end
        else
            local list = ofs.list(path)
            if #path == 0 then
                list[#list + 1] = netroot
            end
            return list
        end
    end

    fs.attributes = function(path)
        local net
        net, path = toNetRoot(path)
        if net then
            local attributes = getAttributes(path)
            if attributes then
                return getAttributes(path)
            else
                error(fs.combine(netroot, path)..": No such file ")
            end
        else
            return ofs.attributes(path)
        end
    end

    fs.exists = function(path)
        local net
        net, path = toNetRoot(path)
        if net then
            return getAttributes(path) and true or false
        else
            return ofs.exists(path)
        end
    end

    fs.isDir = function(path)
        local net
        net, path = toNetRoot(path)
        if net then
            local attributes = getAttributes(path)
            return (attributes and attributes.isDir) and true or false
        else
            return ofs.isDir(path)
        end
    end

    fs.isReadOnly = function(path)
        local net
        net, path = toNetRoot(path)
        if net then
            local attributes = getAttributes(path)
            return (attributes and attributes.isReadOnly) and true or false
        else
            return ofs.isReadOnly(path)
        end
    end

    fs.getDrive = function(path)
        local net
        net, path = toNetRoot(path)
        if net then
            return "net"
        else
            return ofs.getDrive(path)
        end
    end

    fs.getSize = function(path)
        local net
        net, path = toNetRoot(path)
        if net then
            local attributes = getAttributes(path)
            if attributes then
                return attributes.size
            else
                error(fs.combine(netroot, path) .. ": No such file ")
            end
        else
            return ofs.getSize(path)
        end
    end

    fs.getFreeSpace = function(path)
        local net
        net, path = toNetRoot(path)
        if net then
            return syncData.capacity[1]
        else
            return ofs.getFreeSpace(path)
        end
    end

    fs.getCapacity = function (path)
        local net
        net, path = toNetRoot(path)
        if net then
            return syncData.capacity[2]
        else
            return ofs.getCapacity(path)
        end
    end

    -- [[ Network Dependent Overrides ]] --

    local singleOverrides = {
        "makeDir",
        "delete"
    }

    for _, name in ipairs(singleOverrides) do
        fs[name] = function(path)
            local net
            net, path = toNetRoot(path)
            if net then
                local ok, err = netutils.request({
                    type = name,
                    path = path
                })
                if ok then
                    syncData.contents[err.path] = err.attributes or nil
                else
                    error(err)
                end
            else
                return ofs[name](path)
            end
        end
    end

    local doubleOverrides = {
        "move",
        "copy"
    }

    for _, name in ipairs(doubleOverrides) do
        local function relocate(path, dest)
            if fs.exists(dest) then
                error("/"..fs.combine(dest)..": File exists")
            end
            local pnet, dnet
            pnet, path = toNetRoot(path)
            dnet, dest = toNetRoot(dest)
            if pnet and dnet then
                local ok, err = netutils.request({
                    type = name,
                    path = path,
                    dest = dest
                })
                if ok then
                    syncData.contents[err.path] = err.attributes or nil
                else
                    error(err)
                end
            elseif not (pnet or dnet) then
                return ofs[name](path, dest)
            elseif pnet and not dnet then -- from server to client
                if fs.isDir(fs.combine(netroot, dest)) then
                    local list = fs.list(fs.combine(netroot, dest))
                    for _, p in ipairs(list) do
                        relocate(fs.combine(netroot, dest, p), fs.combine(path, p))
                    end
                else
                    local ok, data = netutils.readStream({
                        ok = true,
                        type = "readFile",
                        path = path
                    })
                    if ok then
                        local file = ofs.open(dest, "wb")
                        file.write(data)
                        file.close()
                    else
                        error("Read stream error: "..data)
                    end
                    if name == "move" then
                        return fs.delete, fs.combine(netroot, path)
                    end
                end
            else -- from client to server
                if fs.isDir(path) then
                    local list = fs.list(path)
                    for _, p in ipairs(list) do
                        relocate(fs.combine(path, p), fs.combine(netroot, dest, p))
                    end
                else
                    local file = ofs.open(path, "rb")
                    local data = file.readAll()
                    file.close()
                    local ok, err = netutils.writeStream({
                        ok = true,
                        type = "writeFile",
                        path = dest,
                    }, data)
                    if ok then
                        syncData[err.path] = err.attributes
                    else
                        error("Write stream error: "..data)
                    end
                end
                if name == "move" then
                    return ofs.delete, path
                end
            end
        end

        fs[name] = function(path, dest)
            local func, p = relocate(path, dest)
            if func then
                func(p)
            end
        end
    end

    -- [[ Network Dependent File Handles ]] --

    local function genericHandle(path, binary)
        local internal = {
            buffer = "",
            pos = 0,
            closed = false
        }
        local handle = {}

        if binary then
            handle.seek = function(whence, offset)
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

    local function writeHandle(path, binary, append)
        local handle, internal = genericHandle(path, binary)
        if append then
            local ok, data = netutils.readStream({
                ok = true,
                type = "readFile",
                path = path
            })
            if ok then
                internal.buffer = data
                internal.ibuffer = data
                internal.pos = #data
            else
                error("Read stream error: "..data)
            end
        end

        handle.write = function(text)
            if type(text) == "table" then
                text = string.char(table.unpack(text))
            end
            assert(not internal.closed, "attempt to use a closed file")
            internal.buffer = internal.buffer:sub(0, internal.pos) .. text .. internal.buffer:sub(internal.pos+#text+1, -1)
            internal.pos = internal.pos + #text
        end

        handle.flush = function()
            assert(not internal.closed, "attempt to use a closed file")
            if internal.ibuffer ~= internal.buffer then
                internal.ibuffer = internal.buffer
                local out = internal.buffer:gsub("\n$", "")
                local ok, data = netutils.writeStream({
                    ok = true,
                    type = "writeFile",
                    path = path,
                }, out)
                if ok then
                    syncData.contents[data.path] = data.attributes
                else
                    error("Write stream error: "..(data or "Unknown"))
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
                handle.write(text.."\n")
            end
        end

        return handle
    end

    local function readHandle(path, binary)
        local handle, internal = genericHandle(path, binary)
        local ok, data = netutils.readStream({
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
            local pos = internal.pos
            local out = internal.buffer:sub(pos, -1)
            if internal.pos < #internal.buffer then
                internal.pos = internal.pos + #out
                return out
            end
        end

        return handle
    end

    fs.open = function(path, mode)
        local net
        net, path = toNetRoot(path)
        if net then
            local b = mode:sub(2, 2)
            local binary = (b == "b")
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
        else
            return ofs.open(path, mode)
        end
    end

    do
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
            else
                env[k] = f
            end
        end
        env.fs = fs
        setmetatable(env, {__index = _G})

        assert(pcall(assert(load(romfs, "romfsapi", nil, env))))
        fs.isDriveRoot = isDriveRoot
    end

    return fs
end

-- [[ Main Program / Connection handlers ]] --
local wsclose, syncData

local function pcwrap(f)
    return function(...)
        local res = table.pack(pcall(f, ...))
        if table.remove(res, 1) then
            return table.unpack(res)
        else
            ofs.open("debug.txt", "w")
            ofs.writeLine(table.remove(res, 1))
            ofs.close()
        end
    end
end

local function sync()
    while true do
        local _, wsurl, sres = os.pullEventRaw("websocket_message")
        if wsurl == url and sres then
            local json = unserializeJSON(sres)
            if json and json.type == "sync" and json.data and syncData then
                syncData.contents[json.data.path] = json.data.attributes or nil
                syncData.capacity = json.data.capacity
            end
        end
    end
end

local function subshell()
    term.clear()
    term.setCursorPos(1, 1)
    term.setTextColor(colors.lightBlue)
    write(url)
    term.setTextColor(colors.white)
    write(" mounted to ")
    term.setTextColor(colors.green)
    print(netroot)
    term.setTextColor(colors.white)
    if args.run then
        shell.run(args.run)
    else
        shell.run("shell")
    end
end

local function persist()
    http.websocketAsync(url, auth)
    local attempts, isMounted = 0, false
    while true do
        local eventData = { os.pullEventRaw() }
        local event, wsurl = table.remove(eventData, 1), table.remove(eventData, 1)
        if event == "websocket_success" and wsurl == url then
            attempts = 0
            local ws = eventData[1]
            local send, close = ws.send, ws.close
            ws.send = function(data, binary)
                local ok = pcall(send, data, binary)
                return ok
            end
            ws.close = function()
                pcall(close)
            end
            wsclose = ws.close
            local netutils = createNetutils(ws)
            local ok, syncDataU = netutils.readStream({
                ok = true,
                type = "hello"
            }, true)
            syncData = unserializeJSON(syncDataU)
            if ok and syncData then
                _G.fs = initfs(netutils, syncData)
                isMounted = true
            elseif ok and not syncData then
                error("Hello Stream: Failed to parse JSON")
            else
                error("Hello Stream: " .. syncData)
            end
        elseif event == "websocket_closed" and wsurl == url then
            isMounted, wsclose = false, nil
            attempts = attempts + 1
            if attempts == 3 then
                error("Socket connection failed after 3 attempts")
            else
                sleep(2)
                http.websocketAsync(url, auth)
            end
        elseif event == "websocket_failure" and wsurl == url then
            error("Failed: " .. (eventData[1] or "unknown reason"))
        end
    end
end

local pok, err = pcall(parallel.waitForAny, persist, sync, subshell)
if pok then
    if type(wsclose) == "function" then
        wsclose()
    else
        printError("Websocket closed: " .. (wsclose or "reason unknown"))
        print("Press any key to continue")
        os.pullEvent("key")
    end
else
    printError(err)
    print("Press any key to continue")
    os.pullEvent("key")
end
_G.fs = ofs