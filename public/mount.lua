local ofs = _G.fs
local fs = {}

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

local ws
local function request(data, timeout)
    ws.send(textutils.serializeJSON(data))
    local response = ws.receive(timeout or 5)
    local json
    if response then
        json = textutils.unserializeJSON(response)
    end
    if not (response or json) then
        return false, "Timeout"
    elseif json.ok then
        return true, json.data
    else
        return false, json.err
    end
end

local netroot = table.remove(args, 1) or "net"
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

local copyold = {
    "combine",
    "getName",
    "getDir",
}

for _, fn in ipairs(copyold) do
    fs[fn] = ofs[fn]
end

local singleOverrides = {
    "attributes",
    "exists",
    "isDir",
    "isReadOnly",
    "getDrive",
    "getSize",
    "getFreeSpace",
    "getCapacity",
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
    fs[name] = function(path, dest)
        local pnet, dnet
        pnet, path = toNetRoot(path)
        dnet, dest = toNetRoot(dest)
        if pnet and dnet then
            local ok, err = request({
                type = name,
                path = path,
                dest = dest
            })
            if ok then
                return err
            else
                error(err)
            end
        elseif not (pnet or dnet) then
            return ofs[name](path, dest)
        elseif pnet and not dnet then -- from server to client
            local ok, err = request({
                type = "readFile",
                path = path,
            })
            if ok then
                local file = ofs.open(dest, "w")
                file.write(err)
                file.close()
                if name == "move" then
                    fs.delete(fs.combine(netroot, path))
                end
            else
                error(err)
            end
        else                          -- from client to server
            local file = ofs.open(path, "r")
            local data = file.readAll()
            file.close()
            local ok, err = request({
                type = "writeFile",
                path = dest,
                data = data
            })
            if ok then
                if name == "move" then
                    ofs.delete(path)
                end
            else
                error(err)
            end
        end
    end
end

fs.list = function(path)
    local net
    net, path = toNetRoot(path)
    if net then
        local ok, err = request({
            type = "list",
            path = path
        })
        if ok then
            return err
        else
            error(err)
        end
    else
        local list = ofs.list(path)
        if #path == 0 then
            list[#list + 1] = "net"
        end
        return list
    end
end

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
        local ok, data = request({
            type = "readFile",
            path = path,
        })
        if ok then
            internal.buffer = data
            internal.pos = #data
        else
            error(data)
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
        local ok, data = request({
            type = "writeFile",
            path = path,
            data = internal.buffer
        })
        if not ok then
            error(data)
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
    local ok, data = request({
        type = "readFile",
        path = path,
    })
    if ok then
        internal.buffer = data
    else
        error(data)
    end

    handle.read = function(count)
        assert(not internal.closed, "attempt to use a closed file")
        local out = internal.buffer:sub(internal.pos+1, internal.pos+count)
        if #out > 0 then
            internal.pos = internal.pos + #out
            return out
        end
    end

    handle.readLine = function(withTrailing)
        assert(not internal.closed, "attempt to use a closed file")
        local nl = internal.buffer:sub(internal.pos+1, -1):find("\n")
        local out = internal.buffer:sub(internal.pos + 1,
            internal.pos + 1 + (nl or #internal.buffer + 2) - (withTrailing and 1 or 2))
        local offset = #out + ((withTrailing or not nl) and 0 or 1)
        if offset > 0 then
            internal.pos = internal.pos + offset
            return out
        end
    end

    handle.readAll = function()
        assert(not internal.closed, "attempt to use a closed file")
        local pos = internal.pos
        local out = internal.buffer:sub(pos, -1)
        if #out > 0 then
            internal.pos = #internal.buffer
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

local function run()
    http.websocketAsync(url, auth)
    while true do
        local eventData = {os.pullEventRaw()}
        local event = eventData[1]
        if event == "websocket_success" and eventData[2] == url then
            ws = eventData[3]
            local response = ws.receive(5)
            if response then
                local json = textutils.unserializeJSON(response)
                if json.ok and json.data == "hello" then
                    _G.fs = fs

                    local romfs, i = "", 1
                    for line in io.lines("rom/apis/fs.lua") do
                        -- Rip out definition weirdness
                        if not (i > 9 and i < 14) then
                            romfs = romfs .. line .. "\n"
                        end
                        i = i + 1
                    end
                    assert(pcall(assert(load(romfs, "romfsapi", nil, _ENV))))
                    fs.isDriveRoot = isDriveRoot
                    os.queueEvent("netmount_success", netroot)
                else
                    os.queueEvent("netmount_failure", netroot)
                    printError("Invalid websocket response")
                    ws.close()
                    return
                end
            else
                os.queueEvent("netmount_failure", netroot)
                printError("Failed to establish websocket connection")
                ws.close()
                return
            end
        elseif event == "websocket_closed" and eventData[2] == url then
            os.queueEvent("netmount_closed", netroot)
            printError(eventData[3])
            sleep(2)
            return
        end
    end
end

parallel.waitForAny(run, function()
    local _, path = os.pullEvent("netmount_success")
    if path == netroot then
        term.clear()
        term.setCursorPos(1, 1)
        term.setTextColor(colors.white)
        write(url .. " mounted to ")
        term.setTextColor(colors.green)
        print("net")
        term.setTextColor(colors.white)
        if #args > 0 then
            shell.run(table.unpack(args))
        else
            shell.run("shell")
        end
    end
end)
_G.fs = ofs
if ws then
    ws.close()
end