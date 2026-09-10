export enum MessageType
{
    Diagnostics = 0,
    RequestDebugDatabase,
    DebugDatabase,

    StartDebugging,
    StopDebugging,
    Pause,
    Continue,

    RequestCallStack,
    CallStack,

    ClearBreakpoints,
    SetBreakpoint,

    HasStopped,
    HasContinued,

    StepOver,
    StepIn,
    StepOut,

    EngineBreak,

    RequestVariables,
    Variables,

    RequestEvaluate,
    Evaluate,
    GoToDefinition,

    BreakOptions,
    RequestBreakFilters,
    BreakFilters,

    Disconnect,

    DebugDatabaseFinished,
    AssetDatabaseInit,
    AssetDatabase,
    AssetDatabaseFinished,
    FindAssets,
    DebugDatabaseSettings,

    PingAlive,

    DebugServerVersion,
    CreateBlueprint,

    ReplaceAssetDefinition,

    SetDataBreakpoints,
    ClearDataBreakpoints,

    // Keep the Engine enum tail aligned with the native debug protocol. These
    // entries are intentionally absent from the older extension client.
    StopPIE,
    RequestDiagnosticsSnapshot,
    DiagnosticsSnapshotBegin,
    DiagnosticsSnapshotFinished,

    DebugDatabaseAccessBegin = 54,
    DebugDatabaseAccess,
    DebugDatabaseAccessFinished,
}

export type DebugDatabaseAccessFrame = {
    payload?: string;
};

/** Byte-identical legacy request: the inbound Engine packet length is one
 * byte for the message opcode and carries no request body. */
export function buildLegacyRequestDebugDatabase() : Buffer
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.RequestDebugDatabase, 4);
    return msg;
}

export class Message
{
    type : number;
    offset : number;
    buffer : Buffer;
    size : number;
    remainingSize : number;
    private readonly payloadOffset : number;

    constructor(type : number, offset : number, size : number, buffer : Buffer)
    {
        this.type = type;
        this.offset = offset;
        this.buffer = buffer;
        this.size = size;
        this.payloadOffset = offset;
        this.remainingSize = size;
    }

    readInt() : number
    {
        let value = this.buffer.readIntLE(this.offset, 4);
        this.offset += 4;
        this.remainingSize = this.size - (this.offset - this.payloadOffset);
        return value;
    }

    readByte() : number
    {
        let value = this.buffer.readInt8(this.offset);
        this.offset += 1;
        this.remainingSize = this.size - (this.offset - this.payloadOffset);
        return value;
    }

    readUInt16() : number
    {
        let value = this.buffer.readUInt16LE(this.offset);
        this.offset += 2;
        this.remainingSize = this.size - (this.offset - this.payloadOffset);
        return value;
    }

    readUInt32() : number
    {
        let value = this.buffer.readUInt32LE(this.offset);
        this.offset += 4;
        this.remainingSize = this.size - (this.offset - this.payloadOffset);
        return value;
    }

    readBytes(count : number) : Buffer
    {
        if (!Number.isInteger(count) || count < 0 || count > this.remainingSize)
            throw new Error(`Unreal message payload is truncated (requested ${count}, remaining ${this.remainingSize}).`);
        let value = this.buffer.subarray(this.offset, this.offset + count);
        this.offset += count;
        this.remainingSize = this.size - (this.offset - this.payloadOffset);
        return value;
    }

    readBool() : boolean
    {
        return this.readInt() != 0;
    }

    readString() : string
    {
        let num = this.readInt();
        let ucs2 = num < 0;
        if(ucs2)
        {
            num = -num;
        }

        let byteLength = num * (ucs2 ? 2 : 1);
        if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > this.remainingSize)
            throw new Error(`Unreal message string is truncated (requested ${byteLength}, remaining ${this.remainingSize}).`);

        if(ucs2)
        {
            let str = this.buffer.toString("utf16le", this.offset, this.offset + num * 2);
            this.offset += num * 2;
            if(str[str.length - 1] == '\0')
                str = str.substr(0, str.length - 1);
            this.remainingSize = this.size - (this.offset - this.payloadOffset);
            return str;
        }
        else
        {
            let str = this.buffer.toString("utf8", this.offset, this.offset + num);
            this.offset += num;
            if(str[str.length - 1] == '\0')
                str = str.substr(0, str.length - 1);
            this.remainingSize = this.size - (this.offset - this.payloadOffset);
            return str;
        }
    }
}

/** Parse the tokenless JSON payload on an optional access frame. */
export function readDebugDatabaseAccessFrame(message : Message) : DebugDatabaseAccessFrame
{
    let payload = message.readString();
    if (message.remainingSize != 0)
        throw new Error('DebugDatabase access frame contains an unsupported trailing payload.');
    return { payload };
}

/** Parse the empty optional access Finished frame. */
export function readDebugDatabaseAccessFinishedFrame(message : Message) : DebugDatabaseAccessFrame
{
    if (message.remainingSize != 0)
        throw new Error('DebugDatabase access Finished frame contains an unsupported payload.');
    return {};
}

export class UnrealMessageDecoder
{
    private pendingBuffer : Buffer = Buffer.alloc(0);

    push(buffer : Buffer) : Array<Message>
    {
        let list : Array<Message> = [];
        this.pendingBuffer = Buffer.concat([this.pendingBuffer, buffer]);

        while (this.pendingBuffer.length >= 5)
        {
            let offset = 0;
            let msglen = this.pendingBuffer.readUIntLE(offset, 4);
            offset += 4;
            let msgtype = this.pendingBuffer.readInt8(offset);
            offset += 1;

            if (msglen <= this.pendingBuffer.length - offset)
            {
                list.push(new Message(msgtype, offset, msglen, this.pendingBuffer));
                this.pendingBuffer = this.pendingBuffer.slice(offset + msglen);
            }
            else
            {
                return list;
            }
        }

        return list;
    }
}

function writeInt(value : number) : Buffer
{
    let newBuffer = Buffer.alloc(4);
    newBuffer.writeInt32LE(value, 0);
    return newBuffer;
}

function writeString(str : string) : Buffer
{
    let newBuffer = Buffer.alloc(4);
    newBuffer.writeInt32LE(str.length+1, 0);
    return Buffer.concat([newBuffer, Buffer.from(str+"\0", "binary")]);
}

export function buildGoTo(typename : string, symbolname : string) : Buffer
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.GoToDefinition, 4);

    let msg = Buffer.concat([
        head, writeString(typename), writeString(symbolname)
    ]);

    msg.writeUInt32LE(msg.length - 4, 0);
    return msg;
}

export function buildDisconnect() : Buffer
{
    let msg = Buffer.alloc(5);
    msg.writeUInt32LE(1, 0);
    msg.writeUInt8(MessageType.Disconnect, 4);

    return msg;
}

export function buildOpenAssets(assets : Array<string>, className : string) : Buffer
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.FindAssets, 4);

    let parts = [head, writeInt(1), writeInt(assets.length)];
    for (let asset of assets)
        parts.push(writeString(asset));
    parts.push(writeString(className));
    let msg = Buffer.concat(parts);
    msg.writeUInt32LE(msg.length - 4, 0);
    return msg;
}

export function buildCreateBlueprint(className : string) : Buffer
{
    let head = Buffer.alloc(5);
    head.writeUInt8(MessageType.CreateBlueprint, 4);

    let parts = [head, writeString(className)];
    let msg = Buffer.concat(parts);
    msg.writeUInt32LE(msg.length - 4, 0);
    return msg;
}
