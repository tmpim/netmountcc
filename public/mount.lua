local ofs = _G.fs

-- [[ Simple base64 Encoder ]] --

local b64
do
    -- Lua 5.1+ base64 v3.0 (c) 2009 by Alex Kloss <alexthkloss@web.de>
    -- licensed under the terms of the LGPL2

    -- character table string
    local b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

    -- encoding
    function b64(data)
        return ((data:gsub('.', function(x)
            local r,c='',x:byte()
            for i=8,1,-1 do r=r..(c%2^i-c%2^(i-1)>0 and '1' or '0') end
            return r;
        end)..'0000'):gsub('%d%d%d?%d?%d?%d?', function(x)
            if (#x < 6) then return '' end
            local c=0
            for i=1,6 do c=c+(x:sub(i,i)=='1' and 2^(6-i) or 0) end
            return b:sub(c+1,c+1)
        end)..({ '', '==', '=' })[#data%3+1])
    end
end

-- [[ Argument Parsing ]] --

local args = table.pack(...)

local url, auth
do
    if #args < 3 then
        local keys = {
            "netmount.url",
            "netmount.username",
            "netmount.password",
            "netmount.path"
        }
        for i = 1, #keys do
            args[i] = settings.get(keys[i]) or args[i]
        end
    end
    if #args < 3 then
        print("Usage: mount <url> <username> <password> [path]")
        print("Or, save url, username and password using set. Ex:")
        print("set netmount.url https://netmount.example.com")
        print("setting keys are netmount.url, netmount.username, netmount.password, and netmount.path")
        return
    end
    local username, password
    url, username, password = table.remove(args, 1), table.remove(args, 1), table.remove(args, 1)
    auth = { Authorization = "Basic " .. b64(username .. ":" .. password) }
    url = url:gsub("^http", "ws")
end

local netroot = table.remove(args, 1) or "net"
assert(not ofs.exists(netroot), "Directory "..netroot.." already exists")

-- [[ Local helper, and future override functions ]] --

local function unserializeJSON(str)
    local ok, data = pcall(textutils.unserialiseJSON, str)
    if ok then
        return data
    end
end

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

local chunkSize = 2^16

local function initfs(ws, syncData)

    local function request(data, timeout)
        assert(data.type, "Missing request type")
        ws.send(textutils.serializeJSON(data))
        local reqres
        parallel.waitForAny(function()
            sleep(timeout or 5)
        end, function()
            while true do
                local _, wsurl, response = os.pullEventRaw("websocket_message")
                if wsurl == url and response then
                    local json = unserializeJSON(response)
                    if json.type == data.type then
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

    local function readStream(path)
        local ok, data = request({
            ok = true,
            type = "readFile",
            path = path
        })
        if not ok then
            error(data)
        elseif not data.uuid then
            error("Missing stream UUID")
        else
            local combined = ""
            local chunk = 0
            while true do
                local e, wsurl, rawdata = os.pullEventRaw()
                local response = unserializeJSON(rawdata)
                local matches = (wsurl == url and response and response.type == "readStream" and response.uuid == data.uuid)
                if e == "websocket_message" and matches and response.chunk == chunk then
                    combined = combined .. response.data
                    chunk = chunk + 1
                    ws.send(textutils.serializeJSON({
                        ok = true,
                        type = "readStream",
                        uuid = data.uuid,
                        chunk = chunk
                    }))
                elseif e == "websocket_message" and matches and response.complete then
                    return true, combined
                elseif e == "websocket_close" and wsurl == url then
                    return false, "Websocket Closed"
                end
            end
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

    local function writeStream(path, contents)
        local uuid = v4()
        local ok, data = request({
            ok = true,
            type = "writeFile",
            path = path,
            uuid = uuid
        })
        local function send(chunk)
            local subchunk = contents:sub(chunkSize * chunk, chunkSize * (chunk + 1))
            if #subchunk > 0 then
                ws.send(textutils.serializeJSON({
                    ok = true,
                    type = "writeStream",
                    uuid = uuid,
                    chunk = chunk,
                    data = subchunk
                }))
            else
                ws.send(textutils.serializeJSON({
                    ok = true,
                    type = "writeStream",
                    uuid = uuid,
                    complete = true
                }))
                return true
            end
        end
        send(0)
        while true do
            local e, wsurl, rawdata = os.pullEventRaw()
            local response = unserializeJSON(rawdata)
            local matches = (wsurl == url and response and response.type == "writeStream" and response.uuid == data.uuid)
            if e == "websocket_message" and matches and response.chunk then
                if send(response.chunk) then
                    return true
                end
            elseif e == "websocket_close" and wsurl == url then
                return false, "Websocket Closed"
            end
        end
    end

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
                list[#list + 1] = "net"
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
                local ok, err = request({
                    type = name,
                    path = path
                })
                if ok then
                    return err
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
        local function relocate(path, dest, root)
            if fs.exists(dest) then
                error("/"..fs.combine(dest)..": File exists")
            end
            local pnet, dnet
            pnet, path = toNetRoot(path)
            dnet, dest = toNetRoot(dest)
            if pnet and dnet then
                local ok, err = request({
                    type = name,
                    path = path,
                    dest = dest
                })
                if not ok then
                    error(err)
                end
            elseif not (pnet or dnet) then
                return ofs[name](path, dest)
            elseif pnet and not dnet then -- from server to client
                if fs.isDir(fs.combine(netroot, dest)) then
                    local list = fs.list(fs.combine(netroot, dest))
                    for _, p in ipairs(list) do
                        --print(fs.combine(netroot, dest, p), fs.combine(path, p), p)
                        relocate(fs.combine(netroot, dest, p), fs.combine(path, p), false)
                    end
                else
                    local ok, data = readStream(path)
                    if ok then
                        local file = ofs.open(dest, "w")
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
                        --print(fs.combine(path, p), fs.combine(netroot, dest, p))
                        relocate(fs.combine(path, p), fs.combine(netroot, dest, p), false)
                    end
                else
                    local file = ofs.open(path, "r")
                    local data = file.readAll()
                    file.close()
                    local ok, err = writeStream(dest, data)
                    if not ok then
                        error("Write stream error: "..data)
                    end
                end
                if name == "move" then
                    return ofs.delete, path
                end
            end
        end

        fs[name] = function(path, dest)
            local func, p = relocate(path, dest, true)
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
            local ok, data = readStream(path)
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
                local ok, data = writeStream(path, internal.buffer:gsub("\n$", ""))
                if not ok then
                    error("Write stream error: "..data)
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
        local ok, data = readStream(path)
        if ok then
            internal.buffer = data
        else
            error("Read stream error: "..data)
        end

        handle.read = function(count)
            assert(not internal.closed, "attempt to use a closed file")
            local out = internal.buffer:sub(internal.pos+1, internal.pos+count)
            if internal.pos <= #internal.buffer then
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

local function setup()
    http.websocketAsync(url, auth)
    local eventData = { os.pullEventRaw() }
    local event = eventData[1]
    if event == "websocket_success" and eventData[2] == url then
        local ws = eventData[3]
        local res = unserializeJSON(ws.receive(5))
        if res and res.ok and res.type == "hello" then
            local syncData = res.data

            return true, ws.close, syncData, initfs(ws, syncData)
        else
            ws.close()
            return false, "Failed to complete netmount handshake"
        end
    end
end

local suc, wsclose, syncData, fs = setup()
if suc then
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
                if json.type == "sync" and json.data and syncData then
                    syncData.contents[json.data.path] = json.data.attributes or nil
                end
            end
        end
    end

    local function close()
        while true do
            local _, wsurl, reason, code = os.pullEventRaw("websocket_closed")
            if wsurl == url then
                suc, wsclose, syncData, fs = setup()
                if not suc then
                    return
                end
                _G.fs = fs
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
        if #args > 0 then
            shell.run(table.unpack(args))
        else
            shell.run("shell")
        end
    end

    _G.fs = fs
    parallel.waitForAny(sync, subshell, close)
    if type(wsclose) == "function" then
        wsclose()
    else
        printError("Websocket closed: "..(wsclose or "reason unknown"))
        print("Press any key to continue")
        os.pullEvent("key")
    end
    _G.fs = ofs
else
    printError("Setup failed: "..(wsclose or "reason unknown"))
end