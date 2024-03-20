import WebSocket from "ws";

export function replacer(key: any, value: any) {
    if(value instanceof Map) {
        return Object.fromEntries(value);
    } else {
        return value;
    }
}

export function debug(message?: any, ...optionalParams: any[]) {
    if (process.env.DEBUG) {
        console.log(message, ...optionalParams)
    }
}