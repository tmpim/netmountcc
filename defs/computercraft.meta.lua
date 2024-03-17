---@meta

---@param targetEvent string?
---@return string, any ...
os.pullEvent = function(targetEvent) end

---@param targetEvent string?
---@return string, any ...
os.pullEventRaw = function(targetEvent) end

---@param type "utc"|nil
---@return number
os.epoch = function(type) end

---@param time number
---@return number
os.startTimer = function(time) end

---@param timer number
os.cancelTimer = function(timer) end

colors = {} ---@type table<string, number>

peripheral = {
    ---@param side string
    ---@return boolean
    isPresent = function(side) end,

    ---@param side string
    ---@return string
    getType = function(side) end,

    ---@param side string
    ---@return string[]
    getMethods = function(side) end,

    ---@param side string
    ---@param method string
    ---@return any
    call = function(side, method, ...) end,

    ---@param side string
    ---@return unknown
    wrap = function(side) end,

    ---@param side string
    ---@param filter? fun(name: string, object): boolean
    ---@return unknown
    find = function(side, filter) end,

    ---@return string[]
    getNames = function() end,
}

fs = {
    ---@param path string
    ---@return boolean
    exists = function(path) end,

    ---@param path string
    ---@return boolean
    isDir = function(path) end,

    ---@param path string
    ---@return boolean
    isReadOnly = function(path) end,

    ---@param path string
    ---@return number
    getSize = function(path) end,

    ---@param path string
    ---@return number
    getFreeSpace = function(path) end,

    ---@param path string
    ---@return string | nil
    getDrive = function(path) end,

    ---@param path string
    ---@return string
    getName = function(path) end,

    ---@param path string
    ---@return string
    getDir = function(path) end,

    ---@param basePath string
    ---@param localPath string?
    ---@return string
    combine = function(basePath, localPath) end,

    ---@param path string
    ---@param mode "r" | "w" | "a" | "rb" | "wb" | "ab"
    ---@return FileHandle | nil
    open = function(path, mode) end,

    ---@param path string
    ---@return string[]
    list = function(path) end,

    ---@param path string
    ---@return nil
    makeDir = function(path) end,

    ---@param fromPath string
    ---@param toPath string
    ---@return nil
    move = function(fromPath, toPath) end,

    ---@param fromPath string
    ---@param toPath string
    ---@return nil
    copy = function(fromPath, toPath) end,

    ---@param path string
    ---@return nil
    delete = function(path) end,

    ---@param wildcard string
    ---@return string[]
    find = function(wildcard) end,

    ---@param partial string
    ---@param path string
    ---@param includeFiles? boolean
    ---@param includeSlash? boolean
    ---@return string[]
    complete = function(partial, path, includeFiles, includeSlash) end,
}

---@class FileHandle
---@field close fun()
---@field read fun(): number | nil
---@field readLine fun(): string
---@field readAll fun(): string
---@field write fun(text: string | number)
---@field writeLine fun(text: string) -- Alias for write(text .. "\n")
---@field flush fun()

textutils = {
    ---@param text string
    ---@param rate number
    slowWrite = function(text, rate) end,

    ---@param text string
    ---@param rate number
    slowPrint = function(text, rate) end,

    ---@param time number
    ---@param twentyFourHour boolean
    ---@return string
    formatTime = function(time, twentyFourHour) end,

    ---@param table table | number
    ---@param table2 table | number
    ---@vararg table | number
    tabulate = function(table, table2, ...) end,

    ---@param table table | number
    ---@param table2 table | number
    ---@vararg table | number
    pagedTabulate = function(table, table2, ...) end,

    ---@param text string
    ---@param freeLines number
    ---@return number
    pagedPrint = function(text, freeLines) end,

    ---@param data table | string | number | boolean | nil
    ---@return string
    serialize = function(data) end,

    ---@param serializedData string
    ---@return unknown
    unserialize = function(serializedData) end,

    ---@param data table | string | number | boolean
    ---@param unquoteKeys? boolean
    ---@return string
    serializeJSON = function(data, unquoteKeys) end,

    ---@param serializedData string
    ---@return unknown
    unserializeJSON = function(serializedData) end,

    ---@param urlUnsafeString string
    ---@return string
    urlEncode = function(urlUnsafeString) end,

    ---@param partialName string
    ---@param environment table
    ---@return string[]
    complete = function(partialName, environment) end,
}

---@class MonitorPeripheral: Term
---@field setTextScale fun(scale: number)

---@class WindowTerm: Term
---@field getLine fun(y: integer): string, string, string
---@field setVisible fun(visible: boolean)
---@field isVisible fun(): boolean
---@field redraw fun()
---@field restoreCursor fun()
---@field reposition fun(new_x: integer, new_y: integer, new_width: integer?, new_height: integer?, new_parent: Term?)


---@class Term
term = {
    ---@param text string
    write = function(text) end,

    ---@param text string
    ---@param textColors string
    ---@param backgroundColors string
    blit = function(text, textColors, backgroundColors) end,

    clear = function() end,

    clearLine = function() end,

    ---@return number, number
    getCursorPos = function() end,

    ---@param x number
    ---@param y number
    setCursorPos = function(x, y) end,

    ---@param blink boolean
    setCursorBlink = function(blink) end,

    ---@return boolean
    isColor = function() end,

    ---@return number, number
    getSize = function() end,

    ---@param n number
    scroll = function(n) end,

    ---@param target table
    ---@return Term -- previous terminal object
    redirect = function(target) end,

    ---@return Term
    current = function() end,

    ---@return Term
    native = function() end,

    ---@param color number
    setTextColor = function(color) end,

    ---@return number
    getTextColor = function() end,

    ---@param color number
    setBackgroundColor = function(color) end,

    ---@return number
    getBackgroundColor = function() end,

    ---@param color number
    ---@return number, number, number
    getPaletteColor = function(color) end,

    ---@param color number
    ---@param r number
    ---@param g number
    ---@param b number
    setPaletteColor = function(color, r, g, b) end,
}

---@class Window
window = {
    ---Returns a terminal object that is a space within the specified parent terminal object.
    ---@param parent Term
    ---@param nX integer
    ---@param nY integer
    ---@param nWidth integer
    ---@param nHeight integer
    ---@param bStartVisible boolean?
    ---@return WindowTerm
    create = function(parent, nX, nY, nWidth, nHeight, bStartVisible) end,
}

shell = {
    ---@param command string
    run = function(command, ...) end,
}

os.getComputerID = function() end
os.reboot = function() end
os.queueEvent = function(name, ...) end

---@param time number?
sleep = function(time) end

http = {
    ---@param url string
    ---@param postData? string
    ---@param headers? table<string, string>
    ---@param binary? boolean
    ---@overload fun(options: { url: string, body?: string, headers?: table<string, string>, binary?: boolean, method?: string, redirect?: boolean, timeout?: number })
    request = function(url, postData, headers, binary) end,
    ---@param url string
    ---@param headers? table<string, string>
    ---@overload fun(options: { url: string, body?: string, headers?: table<string, string>, timeout?: number })
    ---@return WebSocketHandle handle
    websocket = function(url, headers) end,
    ---@param url string
    ---@param headers? table<string, string>
    ---@overload fun(options: { url: string, body?: string, headers?: table<string, string>, timeout?: number })
    websocketAsync = function(url, headers)  end,
}

--- @class WebSocketHandle
--- @field send fun(message: string, binary: boolean?)
--- @field receive fun(timeout: number?)
--- @field close fun()


keys = {
    getName = function(code) end, ---@type fun(code: integer): string
    a = 1,                        ---@type integer
    apostrophe = 1,               ---@type integer
    b = 1,                        ---@type integer
    backslash = 1,                ---@type integer
    backspace = 1,                ---@type integer
    c = 1,                        ---@type integer
    capsLock = 1,                 ---@type integer
    comma = 1,                    ---@type integer
    d = 1,                        ---@type integer
    delete = 1,                   ---@type integer
    down = 1,                     ---@type integer
    e = 1,                        ---@type integer
    eight = 1,                    ---@type integer
    ["end"] = 1,                  ---@type integer
    enter = 1,                    ---@type integer
    equals = 1,                   ---@type integer
    f = 1,                        ---@type integer
    f1 = 1,                       ---@type integer
    f10 = 1,                      ---@type integer
    f11 = 1,                      ---@type integer
    f12 = 1,                      ---@type integer
    f13 = 1,                      ---@type integer
    f14 = 1,                      ---@type integer
    f15 = 1,                      ---@type integer
    f16 = 1,                      ---@type integer
    f17 = 1,                      ---@type integer
    f18 = 1,                      ---@type integer
    f19 = 1,                      ---@type integer
    f2 = 1,                       ---@type integer
    f20 = 1,                      ---@type integer
    f21 = 1,                      ---@type integer
    f22 = 1,                      ---@type integer
    f23 = 1,                      ---@type integer
    f24 = 1,                      ---@type integer
    f25 = 1,                      ---@type integer
    f3 = 1,                       ---@type integer
    f4 = 1,                       ---@type integer
    f5 = 1,                       ---@type integer
    f6 = 1,                       ---@type integer
    f7 = 1,                       ---@type integer
    f8 = 1,                       ---@type integer
    f9 = 1,                       ---@type integer
    five = 1,                     ---@type integer
    four = 1,                     ---@type integer
    g = 1,                        ---@type integer
    grave = 1,                    ---@type integer
    h = 1,                        ---@type integer
    home = 1,                     ---@type integer
    i = 1,                        ---@type integer
    insert = 1,                   ---@type integer
    j = 1,                        ---@type integer
    k = 1,                        ---@type integer
    l = 1,                        ---@type integer
    left = 1,                     ---@type integer
    leftAlt = 1,                  ---@type integer
    leftBracket = 1,              ---@type integer
    leftCtrl = 1,                 ---@type integer
    leftShift = 1,                ---@type integer
    leftSuper = 1,                ---@type integer
    m = 1,                        ---@type integer
    menu = 1,                     ---@type integer
    minus = 1,                    ---@type integer
    n = 1,                        ---@type integer
    nine = 1,                     ---@type integer
    numLock = 1,                  ---@type integer
    numPad0 = 1,                  ---@type integer
    numPad1 = 1,                  ---@type integer
    numPad2 = 1,                  ---@type integer
    numPad3 = 1,                  ---@type integer
    numPad4 = 1,                  ---@type integer
    numPad5 = 1,                  ---@type integer
    numPad6 = 1,                  ---@type integer
    numPad7 = 1,                  ---@type integer
    numPad8 = 1,                  ---@type integer
    numPad9 = 1,                  ---@type integer
    numPadAdd = 1,                ---@type integer
    numPadDecimal = 1,            ---@type integer
    numPadDivide = 1,             ---@type integer
    numPadEnter = 1,              ---@type integer
    numPadEqual = 1,              ---@type integer
    numPadMultiply = 1,           ---@type integer
    numPadSubtract = 1,           ---@type integer
    o = 1,                        ---@type integer
    one = 1,                      ---@type integer
    p = 1,                        ---@type integer
    pageDown = 1,                 ---@type integer
    pageUp = 1,                   ---@type integer
    pause = 1,                    ---@type integer
    period = 1,                   ---@type integer
    printScreen = 1,              ---@type integer
    q = 1,                        ---@type integer
    r = 1,                        ---@type integer
    ["return"] = 1,               ---@type integer
    right = 1,                    ---@type integer
    rightAlt = 1,                 ---@type integer
    rightBracket = 1,             ---@type integer
    rightCtrl = 1,                ---@type integer
    rightShift = 1,               ---@type integer
    s = 1,                        ---@type integer
    scollLock = 1,                ---@type integer
    scrollLock = 1,               ---@type integer
    semicolon = 1,                ---@type integer
    seven = 1,                    ---@type integer
    six = 1,                      ---@type integer
    slash = 1,                    ---@type integer
    space = 1,                    ---@type integer
    t = 1,                        ---@type integer
    tab = 1,                      ---@type integer
    three = 1,                    ---@type integer
    two = 1,                      ---@type integer
    u = 1,                        ---@type integer
    up = 1,                       ---@type integer
    v = 1,                        ---@type integer
    w = 1,                        ---@type integer
    x = 1,                        ---@type integer
    y = 1,                        ---@type integer
    z = 1,                        ---@type integer
    zero = 1,                     ---@type integer
}

bit = {
    ---@param n number
    ---@param bits number
    ---@return number
    blshift = function(n, bits) end,

    ---@param n number
    ---@param bits number
    ---@return number
    brshift = function(n, bits) end,

    ---@param n number
    ---@param bits number
    ---@return number
    blogic_rshift = function(n, bits) end,

    ---@param m number
    ---@param n number
    ---@return number
    bxor = function(m, n) end,

    ---@param m number
    ---@param n number
    ---@return number
    bor = function(m, n) end,

    ---@param m number
    ---@param n number
    ---@return number
    band = function(m, n) end,

    ---@param n number
    ---@return number
    bnot = function(n) end,
}

parallel = {
    ---@param function1 fun(): any
    ---@param function2 fun(): any
    ---@vararg fun(): any
    ---@return number stoppedFunction
    waitForAny = function(function1, function2, ...) end,

    ---@param function1 fun(): any
    ---@param function2 fun(): any
    ---@vararg fun(): any
    ---@return nil
    waitForAll = function(function1, function2, ...) end,
}