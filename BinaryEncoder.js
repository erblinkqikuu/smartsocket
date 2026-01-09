/**
 * BinaryEncoder - Client & Server Binary Encoding/Decoding
 * Automatically handles:
 * - JSON to Binary conversion
 * - Compression detection
 * - Chunking for large messages
 * - Decompression on receive
 * 
 * ZERO OVERHEAD - Developers don't need to do anything!
 * This is transparent to application code.
 */

import { promisify } from 'util';
import { createDeflate, createInflate } from 'zlib';

// Promisified zlib compression
const deflateAsync = promisify((data, callback) => {
  const deflate = createDeflate();
  let compressed = Buffer.alloc(0);
  deflate.on('data', chunk => {
    compressed = Buffer.concat([compressed, chunk]);
  });
  deflate.on('end', () => callback(null, compressed));
  deflate.on('error', callback);
  deflate.end(data);
});

const inflateAsync = promisify((data, callback) => {
  const inflate = createInflate();
  let decompressed = Buffer.alloc(0);
  inflate.on('data', chunk => {
    decompressed = Buffer.concat([decompressed, chunk]);
  });
  inflate.on('end', () => callback(null, decompressed));
  inflate.on('error', callback);
  inflate.end(data);
});
const ENCODING_TYPES = {
  BINARY: 1,
  CHUNK: 2,
  COMPRESSED: 3
};

let chunkCounter = 0;
const incomingChunks = new Map();
const bufferPool = new Map();

class BufferPool {
  acquire(size) {
    const key = size;
    if (!bufferPool.has(key)) {
      bufferPool.set(key, []);
    }
    const pool = bufferPool.get(key);
    if (pool.length > 0) {
      return pool.pop();
    }
    return new Uint8Array(size);
  }

  release(buffer) {
    const key = buffer.length;
    if (!bufferPool.has(key)) {
      bufferPool.set(key, []);
    }
    const pool = bufferPool.get(key);
    if (pool.length < 5) {
      pool.push(buffer);
    }
  }
}

const pool = new BufferPool();

/**
 * Automatic Binary Encoder
 * - Detects message size
 * - Auto-compresses if beneficial (>15% savings)
 * - Chunks large messages automatically
 * - Transparent to developers
 */
export class BinaryEncoder {
  /**
   * Encode any data to binary format
   * Handles compression and chunking automatically
   * 
   * @param {string} event - Event name
   * @param {any} data - Data to send
   * @returns {Buffer|Uint8Array|string} - Encoded data ready to send
   * 
   * ZERO DEVELOPER OVERHEAD:
   * socket.send('message', { text: 'Hello' }); // Everything automatic!
   */
  static async encode(event, data) {
    try {
      const payload = { event, data };
      const jsonStr = JSON.stringify(payload);
      const jsonBytes = new TextEncoder().encode(jsonStr);
      
      // Small messages (<1KB): send as plain JSON (no overhead)
      if (jsonBytes.length < 1024) {
        return jsonStr;
      }
      
      // Try compression for larger messages
      if (jsonBytes.length >= 1024) {
        try {
          const compressed = await this._deflateSimple(jsonBytes);
          const compressionRatio = compressed.length / jsonBytes.length;
          
          // Only use compression if it saves >15% (no overhead for small savings)
          if (compressionRatio < 0.85) {
            if (compressed.length > 65536) {
              // Chunked compressed
              return this._encodeChunkedCompressed(compressed, event);
            } else {
              // Single compressed packet
              return this._encodeCompressed(compressed);
            }
          }
        } catch (err) {
          // Fall through to uncompressed
        }
      }
      
      // Uncompressed encoding
      if (jsonBytes.length <= 65536) {
        return this._encodeBinary(jsonStr);
      } else {
        return this._encodeChunked(jsonStr, event);
      }
    } catch (err) {
      console.error(`[BinaryEncoder] Encode error: ${err.message}`);
      // Fallback to plain JSON
      return JSON.stringify({ event, data });
    }
  }

  /**
   * Decode binary data
   * Automatically detects format and decompresses
   * 
   * @param {Buffer|Uint8Array|ArrayBuffer|string} data - Data to decode
   * @returns {object} - Decoded { event, data }
   * 
   * ZERO DEVELOPER OVERHEAD:
   * socket.on('message', (data) => {
   *   console.log(data.event, data.data); // Already decoded!
   * });
   */
  static async decode(data) {
    try {
      // Binary format
      if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
        const view = new Uint8Array(data);
        
        if (view[0] === ENCODING_TYPES.CHUNK) {
          // Handle chunked message
          const result = this._decodeChunk(view);
          if (result.isComplete) {
            const fullData = result.data;
            if (result.isCompressed) {
              const decompressed = await this._inflateSimple(fullData);
              const jsonStr = new TextDecoder().decode(decompressed);
              return JSON.parse(jsonStr);
            } else {
              const jsonStr = new TextDecoder().decode(fullData);
              return JSON.parse(jsonStr);
            }
          }
          return null; // Waiting for more chunks
        } else if (view[0] === ENCODING_TYPES.COMPRESSED) {
          // Single compressed message
          const compressedData = view.subarray(1);
          const decompressed = await this._inflateSimple(compressedData);
          const jsonStr = new TextDecoder().decode(decompressed);
          return JSON.parse(jsonStr);
        } else if (view[0] === ENCODING_TYPES.BINARY) {
          // Binary encoded JSON
          const length = (view[1] << 24) | (view[2] << 16) | (view[3] << 8) | view[4];
          const jsonBytes = view.subarray(5, 5 + length);
          const jsonStr = new TextDecoder().decode(jsonBytes);
          return JSON.parse(jsonStr);
        }
      }
      
      // String format (plain JSON)
      if (typeof data === 'string') {
        return JSON.parse(data);
      }
    } catch (err) {
      console.error(`[BinaryEncoder] Decode error: ${err.message}`);
      return null;
    }
  }

  // ===== PRIVATE ENCODING METHODS =====

  static _encodeCompressed(compressedData) {
    const buffer = pool.acquire(1 + compressedData.length);
    buffer[0] = ENCODING_TYPES.COMPRESSED;
    buffer.set(compressedData, 1);
    return buffer.buffer || buffer;
  }

  static _encodeBinary(jsonStr) {
    const dataBytes = new TextEncoder().encode(jsonStr);
    const buffer = pool.acquire(5 + dataBytes.length);
    
    buffer[0] = ENCODING_TYPES.BINARY;
    
    // Write length (4 bytes, big-endian)
    const length = dataBytes.length;
    buffer[1] = (length >> 24) & 0xFF;
    buffer[2] = (length >> 16) & 0xFF;
    buffer[3] = (length >> 8) & 0xFF;
    buffer[4] = length & 0xFF;
    
    buffer.set(dataBytes, 5);
    return buffer.buffer || buffer;
  }

  static _encodeChunked(jsonStr, event) {
    const dataBytes = new TextEncoder().encode(jsonStr);
    const chunkSize = 65536; // 64KB chunks
    const totalChunks = Math.ceil(dataBytes.length / chunkSize);
    const chunkId = ++chunkCounter;
    const chunks = [];
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, dataBytes.length);
      const chunkData = dataBytes.subarray(start, end);
      
      const buffer = pool.acquire(17 + chunkData.length);
      
      buffer[0] = ENCODING_TYPES.CHUNK;
      
      // Chunk ID
      buffer[1] = (chunkId >> 24) & 0xFF;
      buffer[2] = (chunkId >> 16) & 0xFF;
      buffer[3] = (chunkId >> 8) & 0xFF;
      buffer[4] = chunkId & 0xFF;
      
      // Total chunks
      buffer[5] = (totalChunks >> 24) & 0xFF;
      buffer[6] = (totalChunks >> 16) & 0xFF;
      buffer[7] = (totalChunks >> 8) & 0xFF;
      buffer[8] = totalChunks & 0xFF;
      
      // Chunk index
      buffer[9] = (i >> 24) & 0xFF;
      buffer[10] = (i >> 16) & 0xFF;
      buffer[11] = (i >> 8) & 0xFF;
      buffer[12] = i & 0xFF;
      
      // Chunk size
      const size = chunkData.length;
      buffer[13] = (size >> 24) & 0xFF;
      buffer[14] = (size >> 16) & 0xFF;
      buffer[15] = (size >> 8) & 0xFF;
      buffer[16] = size & 0xFF;
      
      buffer.set(chunkData, 17);
      chunks.push(buffer.buffer || buffer);
    }
    
    return chunks;
  }

  static _encodeChunkedCompressed(compressedData, event) {
    const chunkSize = 65536;
    const totalChunks = Math.ceil(compressedData.length / chunkSize);
    const chunkId = ++chunkCounter;
    const chunks = [];
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, compressedData.length);
      const chunkData = compressedData.subarray(start, end);
      
      const buffer = pool.acquire(17 + chunkData.length);
      
      buffer[0] = ENCODING_TYPES.CHUNK;
      
      // Chunk ID with compression flag
      const compressedId = chunkId | 0x80000000;
      buffer[1] = (compressedId >> 24) & 0xFF;
      buffer[2] = (compressedId >> 16) & 0xFF;
      buffer[3] = (compressedId >> 8) & 0xFF;
      buffer[4] = compressedId & 0xFF;
      
      // Total chunks
      buffer[5] = (totalChunks >> 24) & 0xFF;
      buffer[6] = (totalChunks >> 16) & 0xFF;
      buffer[7] = (totalChunks >> 8) & 0xFF;
      buffer[8] = totalChunks & 0xFF;
      
      // Chunk index
      buffer[9] = (i >> 24) & 0xFF;
      buffer[10] = (i >> 16) & 0xFF;
      buffer[11] = (i >> 8) & 0xFF;
      buffer[12] = i & 0xFF;
      
      // Chunk size
      const size = chunkData.length;
      buffer[13] = (size >> 24) & 0xFF;
      buffer[14] = (size >> 16) & 0xFF;
      buffer[15] = (size >> 8) & 0xFF;
      buffer[16] = size & 0xFF;
      
      buffer.set(chunkData, 17);
      chunks.push(buffer.buffer || buffer);
    }
    
    return chunks;
  }

  // ===== PRIVATE DECODING METHODS =====

  static _decodeChunk(view) {
    const chunkId = (view[1] << 24) | (view[2] << 16) | (view[3] << 8) | view[4];
    const isCompressed = (chunkId & 0x80000000) !== 0;
    const cleanChunkId = chunkId & 0x7FFFFFFF;
    
    const totalChunks = (view[5] << 24) | (view[6] << 16) | (view[7] << 8) | view[8];
    const chunkIndex = (view[9] << 24) | (view[10] << 16) | (view[11] << 8) | view[12];
    const chunkSize = (view[13] << 24) | (view[14] << 16) | (view[15] << 8) | view[16];
    
    const chunkData = view.subarray(17, 17 + chunkSize);
    
    // Initialize message if first chunk
    if (!incomingChunks.has(cleanChunkId)) {
      incomingChunks.set(cleanChunkId, {
        totalChunks,
        chunks: new Array(totalChunks),
        received: 0,
        totalSize: 0,
        isCompressed
      });
    }
    
    const message = incomingChunks.get(cleanChunkId);
    message.chunks[chunkIndex] = chunkData;
    message.received++;
    message.totalSize += chunkSize;
    
    // If all chunks received, reassemble
    if (message.received === totalChunks) {
      const fullData = new Uint8Array(message.totalSize);
      let offset = 0;
      for (let i = 0; i < totalChunks; i++) {
        fullData.set(message.chunks[i], offset);
        offset += message.chunks[i].length;
      }
      
      incomingChunks.delete(cleanChunkId);
      
      return {
        isComplete: true,
        data: fullData,
        isCompressed: message.isCompressed
      };
    }
    
    return { isComplete: false };
  }

  // ===== COMPRESSION HELPERS =====
  // Node.js zlib DEFLATE compression/decompression
  
  static async _deflateSimple(data) {
    try {
      const compressed = await deflateAsync(data);
      return compressed;
    } catch (err) {
      console.error('[BinaryEncoder] Compression error:', err);
      return data; // Fallback to uncompressed
    }
  }

  static async _inflateSimple(data) {
    try {
      const decompressed = await inflateAsync(data);
      return decompressed;
    } catch (err) {
      console.error('[BinaryEncoder] Decompression error:', err);
      return data; // Fallback to uncompressed
    }
  }
}

export default BinaryEncoder;
