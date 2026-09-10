import assert from 'node:assert/strict';
import test from 'node:test';
import {
    MessageType,
    Message,
    UnrealMessageDecoder,
    buildLegacyRequestDebugDatabase,
    readDebugDatabaseAccessFinishedFrame,
    readDebugDatabaseAccessFrame,
} from '../unreal-buffers';

function frame(type: MessageType, payload: Buffer) : Buffer
{
    let header = Buffer.alloc(5);
    header.writeUInt32LE(payload.length, 0);
    header.writeUInt8(type, 4);
    return Buffer.concat([header, payload]);
}

test('a partial frame from an old socket cannot contaminate a replacement socket', () => {
    let staleFrame = frame(MessageType.DebugDatabase, Buffer.from('stale'));
    let oldSocketDecoder = new UnrealMessageDecoder();
    assert.deepEqual(oldSocketDecoder.push(staleFrame.subarray(0, 7)), []);

    let replacementFrame = frame(MessageType.DebugDatabaseFinished, Buffer.from('replacement'));
    let replacementSocketDecoder = new UnrealMessageDecoder();
    let messages = replacementSocketDecoder.push(replacementFrame);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, MessageType.DebugDatabaseFinished);
    assert.equal(messages[0].buffer.subarray(messages[0].offset, messages[0].offset + messages[0].size).toString(), 'replacement');
});

test('two sockets can interleave partial frames without sharing decoder state', () => {
    let firstFrame = frame(MessageType.DebugDatabase, Buffer.from('first'));
    let secondFrame = frame(MessageType.AssetDatabase, Buffer.from('second'));
    let firstSocketDecoder = new UnrealMessageDecoder();
    let secondSocketDecoder = new UnrealMessageDecoder();

    assert.deepEqual(firstSocketDecoder.push(firstFrame.subarray(0, 6)), []);
    assert.deepEqual(secondSocketDecoder.push(secondFrame.subarray(0, 8)), []);
    let first = firstSocketDecoder.push(firstFrame.subarray(6));
    let second = secondSocketDecoder.push(secondFrame.subarray(8));

    assert.equal(first.length, 1);
    assert.equal(first[0].type, MessageType.DebugDatabase);
    assert.equal(first[0].buffer.subarray(first[0].offset, first[0].offset + first[0].size).toString(), 'first');
    assert.equal(second.length, 1);
    assert.equal(second[0].type, MessageType.AssetDatabase);
    assert.equal(second[0].buffer.subarray(second[0].offset, second[0].offset + second[0].size).toString(), 'second');
});

test('legacy base request remains empty and optional access uses appended opcodes', () => {
    let legacy = buildLegacyRequestDebugDatabase();
    assert.equal(legacy.readUInt32LE(0), 1);
    assert.equal(legacy[4], MessageType.RequestDebugDatabase);
    assert.equal(MessageType.DebugDatabaseAccessBegin, 54);
    assert.equal(MessageType.DebugDatabaseAccess, 55);
    assert.equal(MessageType.DebugDatabaseAccessFinished, 56);
});

test('optional access frames carry tokenless JSON and an empty Finished payload', () => {
    let json = Buffer.from('{"properties":[],"methods":[]}\0', 'utf8');
    let jsonLength = Buffer.alloc(4);
    jsonLength.writeInt32LE(json.length, 0);
    let access = new UnrealMessageDecoder().push(frame(
        MessageType.DebugDatabaseAccess,
        Buffer.concat([jsonLength, json]),
    ))[0];
    assert.deepEqual(readDebugDatabaseAccessFrame(access), {
        payload: '{"properties":[],"methods":[]}',
    });
    let finished = new UnrealMessageDecoder().push(frame(
        MessageType.DebugDatabaseAccessFinished,
        Buffer.alloc(0),
    ))[0];
    assert.deepEqual(readDebugDatabaseAccessFinishedFrame(finished), {});
});

test('tokenless access parser accepts valid UTF-16 FString payloads', () => {
    let text = '权限';
    let encoded = Buffer.from(`${text}\0`, 'utf16le');
    let length = Buffer.alloc(4);
    length.writeInt32LE(-(text.length + 1), 0);
    let message = new UnrealMessageDecoder().push(frame(
        MessageType.DebugDatabaseAccess,
        Buffer.concat([length, encoded]),
    ))[0];
    assert.deepEqual(readDebugDatabaseAccessFrame(message), { payload: text });
});
