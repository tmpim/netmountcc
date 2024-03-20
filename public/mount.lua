local _
local ofs = assert(_G.fs, "-eh?")
-- [[ Argument Parsing ]] --
local args = table.pack(...)
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
                args[key] = settings.get("netmount." .. key)
            end
        end
        args.path = args.path or "net"
    end
    if not (args.username and args.url) then
        print("Usage: mount [url=<url>] [username=<username>] [password=<password>] [path=<path>] [run=<program>]")
        print("Or, save url, username and password using set. Ex:")
        print("set netmount.url https://netmount.example.com")
        print("setting keys are netmount.url, netmount.username, netmount.password, and netmount.path")
        return
    end
end

local handle = assert(http.get(args.url:gsub("/$", "").."/api.lua"))
local _, nm = assert(pcall(assert(load(handle.readAll(), "nmapi", nil, _ENV))))
handle.close()
local state = assert(nm.createState(args.url, args.username, args.password))

local netroot = ofs.combine(args.path)
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

local function wrapfs()
    local nfs = nm.createFs(state, args.path)

    local api = {}

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
        api[fn] = ofs[fn]
    end

    -- [[ Network Dependent Overrides ]] --

    local singleOverrides = {
        "makeDir", "delete", "list",
        "attributes", "exists", "isDir",
        "isReadOnly", "getDrive", "getSize",
        "getFreeSpace", "getCapacity",
    }

    for _, name in ipairs(singleOverrides) do
        api[name] = function(path)
            local net
            net, path = toNetRoot(path)
            if net then
                return nfs[name](path)
            else
                local out = ofs[name](path)
                if #fs.combine(path) == 0 then
                    if name == "list" then
                        ---@cast out string[]
                        out[#out + 1] = args.path
                        table.sort(out, function(a, b)
                            return #a < #b
                        end)
                    end
                end
                return out
            end
        end
    end

    local doubleOverrides = {
        "move",
        "copy"
    }

    --- Bidirectionally handle relocating files
    ---@param path string
    ---@param dest string
    local function relocate(name, path, dest)
        if api.exists(dest) then
            error("/" .. api.combine(dest) .. ": File exists")
        end
        local pnet, dnet
        pnet, path = toNetRoot(path)
        dnet, dest = toNetRoot(dest)
        if pnet and dnet then
            nfs[name](path, dest)
        elseif not (pnet or dnet) then
            ofs[name](path, dest)
        else
            local pfs, dfs, perr, derr
            local estr = "Failed to open %s file %s"
            if pnet and not dnet then -- from server to client
                pfs, dfs = nfs, ofs
                perr, derr = "remote", "local"
            else -- from client to server
                pfs, dfs = ofs, nfs
                perr, derr = "local", "remote"
            end
            if pfs.isDir(path) then
                local list = pfs.list(path)
                for _, p in ipairs(list) do
                    relocate(api.combine(path, p), api.combine(dest, p))
                end
            else
                local pfile, dfile = assert(pfs.open(path, "rb"), estr:format(perr, path)), assert(dfs.open(dest, "wb"), estr:format(derr, dest))
                dfile.write(pfile.readAll())
                pfile.close()
                dfile.close()
                if name == "move" then
                    pfs.delete(path)
                end
            end
        end
    end

    for _, name in ipairs(doubleOverrides) do
        api[name] = function(path, dest)
            relocate(name, path, dest)
        end
    end

    -- [[ Network Dependent File Handles ]] --

    api.open = function(path, mode)
        local net
        net, path = toNetRoot(path)
        if net then
            return nfs.open(path, mode)
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
        env.fs = api
        setmetatable(env, {__index = _G})

        assert(pcall(assert(load(romfs, "romfsapi", nil, env))))
        api.isDriveRoot = isDriveRoot
    end

    return api
end

-- [[ Main Program / Connection handlers ]] --
_G.fs = wrapfs()
local function subshell()
    term.clear()
    term.setCursorPos(1, 1)
    term.setTextColor(colors.lightBlue)
    write(args.url)
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

local pok, err = pcall(parallel.waitForAny, nm.getSyncHandler(state), nm.getConnectionHandler(state), subshell)
if not pok then
    printError(err)
end
state.close()
print("Press any key to continue")
os.pullEvent("key")
_G.fs = ofs