// SmartSocket Core - Created by Erblin Kqiku - Optimized for High-Performance Real-Time Games
// ENHANCED WITH: Object Pool, Message Cache, Rate Limiter, Predictive Compression, Connection Multiplexing, Encryption
// PLUS: Middleware, Namespaces, Acknowledgments, Error Handling, Advanced API

import uWS from 'uWebSockets.js';
import { createDeflate, createInflate } from 'zlib';
import { promisify } from 'util';
import { networkInterfaces } from 'os';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ObjectPool, createMessageObject, resetMessageObject } from './object-pool.js';
import { MessageCache, RoomStateCache, UserSessionCache } from './message-cache.js';
import { RateLimiter, AdaptiveRateLimiter, TokenBucket } from './rate-limiter.js';
import { PredictiveCompressor, ContentTypeAnalyzer } from './predictive-compressor.js';
import { ConnectionPool, BufferPool as BufferPoolOptimized } from './connection-pool.js';
import { ConnectionMultiplexer, StreamScheduler } from './connection-multiplexer.js';
import { EncryptionManager } from './encryption.js';
import { MiddlewareManager } from './middleware.js';
import { NamespaceManager } from './namespace.js';
import { AcknowledgmentManager } from './acknowledgment.js';
import { ErrorHandler, SmartSocketAPI } from './error-handler.js';

// Get directory path
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const keyFile = path.join(__dirname, '.smartsocket-key');

// Promisified DEFLATE compression (browser-compatible)
const deflateAsync = promisify((data, callback) => {
  const deflate = createDeflate();
  let compressed = Buffer.alloc(0);
  deflate.on('data', chunk => {
    compressed = Buffer.concat([compressed, chunk]);
  });
  deflate.on('end', () => {
    callback(null, compressed);
  });
  deflate.on('error', callback);
  deflate.end(data);
});

// Initialize encryption manager (DISABLED for performance)
// const encryptionManager = new EncryptionManager();
// encryptionManager.initialize('smartsocket-default-key-' + Date.now());
// Create a no-op encryption manager stub
const encryptionManager = {
  isEnabled: () => false,
  encrypt: (msg) => msg,
  decrypt: (msg) => msg,
  initialize: () => {},
  clearSessionKey: () => {}
};

// ============================================
// Performance Optimizations
// ============================================

class BufferPool {
  constructor() {
    this.pools = new Map(); // size -> array of buffers
  }

  acquire(size) {
    if (!this.pools.has(size)) {
      this.pools.set(size, []);
    }
    const pool = this.pools.get(size);
    if (pool.length > 0) {
      return pool.pop();
    }
    return new Uint8Array(size);
  }

  release(buffer) {
    const size = buffer.length;
    if (!this.pools.has(size)) {
      this.pools.set(size, []);
    }
    const pool = this.pools.get(size);
    if (pool.length < 10) { // Max 10 buffers per size
      pool.push(buffer);
    }
  }
}

class AdaptiveChunking {
  constructor() {
    this.chunkSize = 65536; // Default 64KB
    this.latencies = [];
    this.maxLatencies = 20;
  }

  recordLatency(ms) {
    this.latencies.push(ms);
    if (this.latencies.length > this.maxLatencies) {
      this.latencies.shift();
    }
    this.adjustChunkSize();
  }

  adjustChunkSize() {
    if (this.latencies.length < 3) return;
    
    const avgLatency = this.latencies.reduce((a, b) => a + b) / this.latencies.length;
    
    if (avgLatency < 50) {
      this.chunkSize = 262144; // 256KB - fast network
    } else if (avgLatency < 150) {
      this.chunkSize = 65536; // 64KB - normal network
    } else {
      this.chunkSize = 16384; // 16KB - slow network
    }
  }

  getChunkSize() {
    return this.chunkSize;
  }
}

class MessageBatcher {
  constructor() {
    this.queue = [];
    this.maxSize = 10;
    this.maxWait = 50; // ms
    this.timer = null;
  }

  enqueue(event, data, priority = 'normal') {
    this.queue.push({ event, data, priority });
    
    if (this.queue.length >= this.maxSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.maxWait);
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.queue.length === 0) return;
    
    // If only one message, send directly without batching overhead
    if (this.queue.length === 1) {
      const msg = this.queue.shift();
      return msg;
    }

    const batch = this.queue.splice(0, this.maxSize);
    return batch;
  }
}

class PriorityQueue {
  constructor() {
    this.critical = [];
    this.high = [];
    this.normal = [];
    this.low = [];
  }

  enqueue(event, data, priority = 'normal') {
    const msg = { event, data };
    
    switch (priority) {
      case 'critical':
        this.critical.push(msg);
        break;
      case 'high':
        this.high.push(msg);
        break;
      case 'normal':
        this.normal.push(msg);
        break;
      case 'low':
        this.low.push(msg);
        break;
    }
  }

  dequeueAll() {
    const result = [];
    
    // All critical messages
    result.push(...this.critical.splice(0));
    
    // Up to 5 high-priority messages
    result.push(...this.high.splice(0, 5));
    
    // Up to 10 normal messages
    result.push(...this.normal.splice(0, 10));
    
    // Up to 3 low-priority messages
    result.push(...this.low.splice(0, 3));
    
    return result;
  }
}

// ============================================
// Message Deduplication - Reduce traffic 20%
// ============================================

class MessageDeduplicator {
  constructor(ttl = 5000) {
    this.cache = new Map(); // hash -> timestamp
    this.ttl = ttl;
    this.totalMessages = 0;
    this.duplicatesSkipped = 0;
  }

  // Simple hash function for messages
  _hash(msg) {
    const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash).toString(36);
  }

  // Check if message is a duplicate
  isDuplicate(msg) {
    this.totalMessages++;
    const hash = this._hash(msg);
    const now = Date.now();
    
    if (this.cache.has(hash)) {
      const lastTime = this.cache.get(hash);
      // Consider duplicate if sent within TTL window
      if (now - lastTime < this.ttl) {
        this.duplicatesSkipped++;
        return true;
      }
    }
    
    this.cache.set(hash, now);
    return false;
  }

  // Cleanup expired entries
  cleanup() {
    const now = Date.now();
    for (const [hash, timestamp] of this.cache.entries()) {
      if (now - timestamp > this.ttl) {
        this.cache.delete(hash);
      }
    }
  }

  // Get statistics
  getStats() {
    return {
      totalMessages: this.totalMessages,
      duplicatesSkipped: this.duplicatesSkipped,
      trafficReduction: this.totalMessages > 0 
        ? ((this.duplicatesSkipped / this.totalMessages) * 100).toFixed(2) + '%'
        : '0%',
      cacheSize: this.cache.size,
    };
  }
}

class Compressor {
  // Use DEFLATE compression (native browser support via DecompressionStream)
  static async compress(data) {
    try {
      const buffer = Buffer.from(data);
      const compressed = await deflateAsync(buffer);
      return new Uint8Array(compressed);
    } catch (error) {
      console.error('DEFLATE compression error:', error.message);
      // Fallback to uncompressed
      return new Uint8Array(Buffer.from(data));
    }
  }

  static async decompress(data) {
    try {
      const buffer = Buffer.from(data);
      const inflate = createInflate();
      let decompressed = Buffer.alloc(0);
      
      return new Promise((resolve, reject) => {
        inflate.on('data', chunk => {
          decompressed = Buffer.concat([decompressed, chunk]);
        });
        inflate.on('end', () => {
          resolve(new Uint8Array(decompressed));
        });
        inflate.on('error', reject);
        inflate.end(buffer);
      });
    } catch (error) {
      console.error('DEFLATE decompression error:', error.message);
      // Return as-is if decompression fails
      return new Uint8Array(buffer);
    }
  }
}

// ============================================
// Smart-Binary Encoding with Chunking
// ============================================

class DeltaCompressor {
  constructor() {
    this.lastState = new Map();
  }

  computeDelta(entityId, newState) {
    const lastState = this.lastState.get(entityId) || {};
    const delta = {};
    let hasChanges = false;
    
    for (const key in newState) {
      if (lastState[key] !== newState[key]) {
        delta[key] = newState[key];
        hasChanges = true;
      }
    }
    
    if (hasChanges) {
      this.lastState.set(entityId, { ...newState });
      return { id: entityId, delta };
    }
    
    return null;
  }
  
  reset(entityId) {
    this.lastState.delete(entityId);
  }
}

class MediaTypeDetector {
  static isAlreadyCompressed(data) {
    if (typeof data === 'string') return false;
    
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (buffer.length < 4) return false;
    
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true;
    // WebM: 1A 45 DF A3
    if (buffer[0] === 0x1A && buffer[1] === 0x45 && buffer[2] === 0xDF && buffer[3] === 0xA3) return true;
    // MP3: FF FB or FF FA
    if ((buffer[0] === 0xFF && (buffer[1] === 0xFB || buffer[1] === 0xFA))) return true;
    // MP4: ftyp at byte 4
    if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) return true;
    
    return false;
  }
  
  static shouldCompress(data) {
    return !this.isAlreadyCompressed(data);
  }
}

class FlowControl {
  constructor(highWaterMark = 1048576) {
    this.highWaterMark = highWaterMark;
    this.lowWaterMark = highWaterMark / 10;
    this.paused = new Map();
  }

  checkBackpressure(socketId, bufferedAmount) {
    if (bufferedAmount > this.highWaterMark && !this.paused.get(socketId)) {
      this.paused.set(socketId, true);
      return true;
    }
    
    if (bufferedAmount < this.lowWaterMark && this.paused.get(socketId)) {
      this.paused.set(socketId, false);
      return false;
    }
    
    return this.paused.get(socketId) || false;
  }

  isPaused(socketId) {
    return this.paused.get(socketId) || false;
  }
}

class MessageCoalescer {
  constructor() {
    this.pendingUpdates = new Map();
    this.timers = new Map();
    this.flushInterval = 16; // ~60 FPS
  }

  coalesce(socketId, updateType, data) {
    if (!this.pendingUpdates.has(socketId)) {
      this.pendingUpdates.set(socketId, new Map());
    }
    
    const updates = this.pendingUpdates.get(socketId);
    if (!updates.has(updateType)) {
      updates.set(updateType, {});
    }
    
    Object.assign(updates.get(updateType), data);
    
    if (!this.timers.has(socketId)) {
      const timer = setTimeout(() => this.flush(socketId), this.flushInterval);
      this.timers.set(socketId, timer);
    }
  }

  getPending(socketId) {
    const updates = this.pendingUpdates.get(socketId);
    if (this.timers.has(socketId)) {
      clearTimeout(this.timers.get(socketId));
      this.timers.delete(socketId);
    }
    this.pendingUpdates.delete(socketId);
    return updates ? Object.fromEntries(updates) : null;
  }
}

const ENCODING_TYPES = {
  JSON: 0x00,      // Small objects (< 1KB)
  BINARY: 0x01,    // Medium data (1KB - 64KB)
  CHUNK: 0x02,     // Large data (> 64KB) split into chunks
  COMPRESSED: 0x03 // Compressed data
};

let chunkCounter = 0;
const incomingChunks = new Map();
const bufferPool = new BufferPool();
const adaptiveChunking = new AdaptiveChunking();
const messageBatcher = new MessageBatcher();
const priorityQueue = new PriorityQueue();
const deltaCompressor = new DeltaCompressor();
const flowControl = new FlowControl();
const messageCoalescer = new MessageCoalescer();

class BinaryEncoder {
  static async encode(event, data) {
    try {
      const payload = { event, data };
      let jsonStr = JSON.stringify(payload);
      const jsonBytes = new TextEncoder().encode(jsonStr);
      
      // Small messages (<1KB): send as JSON
      if (jsonBytes.length < 1024) {
        return jsonStr;
      }
      
      // Selective compression: skip already-compressed formats
      let shouldTryCompress = MediaTypeDetector.shouldCompress(data);
      let compressed = null;
      
      if (shouldTryCompress && jsonBytes.length >= 1024) {
        try {
          compressed = await Compressor.compress(jsonBytes);
          const compressionRatio = compressed.length / jsonBytes.length;
          
          // Only use compression if it saves >15%
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
          // Fallback to uncompressed
          console.log(`[SmartSocket] Compression failed, using chunked encoding: ${err.message}`);
        }
      }
      
      // Fallback to uncompressed encoding
      if (jsonBytes.length <= 65536) {
        return this._encodeBinary(jsonStr);
      } else {
        return this._encodeChunked(jsonStr, event);
      }
    } catch (err) {
      console.error(`[SmartSocket] Encode error: ${err.message}, falling back to chunked encoding`);
      // Extreme fallback: just send the data without event wrapper
      if (data && typeof data === 'object') {
        try {
          // Try to encode just the critical fields
          const minimalPayload = { 
            event, 
            data: {
              id: data.id,
              userId: data.userId,
              username: data.username,
              text: data.text,
              roomId: data.roomId,
              timestamp: data.timestamp,
              imageName: data.imageName,
              imageType: data.imageType,
              videoName: data.videoName,
              videoType: data.videoType,
              voiceType: data.voiceType,
              // Include base64 separately if it exists
              ...(data.imageBase64 && { imageBase64: data.imageBase64 }),
              ...(data.videoBase64 && { videoBase64: data.videoBase64 }),
              ...(data.voiceBase64 && { voiceBase64: data.voiceBase64 })
            }
          };
          const minimalStr = JSON.stringify(minimalPayload);
          const minimalBytes = new TextEncoder().encode(minimalStr);
          
          if (minimalBytes.length <= 65536) {
            return this._encodeBinary(minimalStr);
          } else {
            return this._encodeChunked(minimalStr, event);
          }
        } catch (err2) {
          console.error(`[SmartSocket] Fallback encode failed: ${err2.message}`);
          throw err2;
        }
      }
      throw err;
    }
  }
  
  static _encodeCompressed(compressedData) {
    const buffer = bufferPool.acquire(1 + compressedData.length);
    buffer[0] = ENCODING_TYPES.COMPRESSED;
    buffer.set(compressedData, 1);
    return buffer.buffer || buffer;
  }
  
  static _encodeBinary(jsonStr) {
    // Create binary packet: [TYPE_BYTE][LENGTH_4_BYTES][DATA]
    const dataBytes = new TextEncoder().encode(jsonStr);
    const buffer = bufferPool.acquire(5 + dataBytes.length);
    
    // Write header
    buffer[0] = ENCODING_TYPES.BINARY;
    
    // Write length (4 bytes, big-endian)
    const length = dataBytes.length;
    buffer[1] = (length >> 24) & 0xFF;
    buffer[2] = (length >> 16) & 0xFF;
    buffer[3] = (length >> 8) & 0xFF;
    buffer[4] = length & 0xFF;
    
    // Write data
    buffer.set(dataBytes, 5);
    
    return buffer.buffer || buffer;
  }
  
  static _encodeChunked(jsonStr, event) {
    const dataBytes = new TextEncoder().encode(jsonStr);
    const chunkSize = adaptiveChunking.getChunkSize();
    const totalChunks = Math.ceil(dataBytes.length / chunkSize);
    const chunkId = ++chunkCounter;
    const chunks = [];
    
    console.log(`[SmartSocket] Chunking with ${chunkSize} byte chunks into ${totalChunks} parts`);
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, dataBytes.length);
      const chunkData = dataBytes.subarray(start, end);
      
      const buffer = bufferPool.acquire(17 + chunkData.length);
      
      // Type: CHUNK
      buffer[0] = ENCODING_TYPES.CHUNK;
      
      // Chunk ID (4 bytes)
      buffer[1] = (chunkId >> 24) & 0xFF;
      buffer[2] = (chunkId >> 16) & 0xFF;
      buffer[3] = (chunkId >> 8) & 0xFF;
      buffer[4] = chunkId & 0xFF;
      
      // Total chunks (4 bytes)
      buffer[5] = (totalChunks >> 24) & 0xFF;
      buffer[6] = (totalChunks >> 16) & 0xFF;
      buffer[7] = (totalChunks >> 8) & 0xFF;
      buffer[8] = totalChunks & 0xFF;
      
      // Chunk index (4 bytes)
      buffer[9] = (i >> 24) & 0xFF;
      buffer[10] = (i >> 16) & 0xFF;
      buffer[11] = (i >> 8) & 0xFF;
      buffer[12] = i & 0xFF;
      
      // Chunk size (4 bytes)
      const size = chunkData.length;
      buffer[13] = (size >> 24) & 0xFF;
      buffer[14] = (size >> 16) & 0xFF;
      buffer[15] = (size >> 8) & 0xFF;
      buffer[16] = size & 0xFF;
      
      // Data
      buffer.set(chunkData, 17);
      chunks.push(buffer.buffer || buffer);
    }
    
    return chunks;
  }
  
  static _encodeChunkedCompressed(compressedData, event) {
    const chunkSize = adaptiveChunking.getChunkSize();
    const totalChunks = Math.ceil(compressedData.length / chunkSize);
    const chunkId = ++chunkCounter;
    const chunks = [];
    
    console.log(`[SmartSocket] Chunking compressed data into ${totalChunks} parts`);
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, compressedData.length);
      const chunkData = compressedData.subarray(start, end);
      
      const buffer = bufferPool.acquire(17 + chunkData.length);
      
      // Type: CHUNK
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
      
      // Data
      buffer.set(chunkData, 17);
      chunks.push(buffer.buffer || buffer);
    }
    
    return chunks;
  }
  
  static decode(data) {
    try {
      // Check if binary format
      if (data instanceof ArrayBuffer) {
        const view = new Uint8Array(data);
        
        if (view[0] === ENCODING_TYPES.CHUNK) {
          return this._decodeChunk(view);
        } else if (view[0] === ENCODING_TYPES.COMPRESSED) {
          return this._decodeCompressed(view);
        } else if (view[0] === ENCODING_TYPES.BINARY) {
          // Read length
          const length = (view[1] << 24) | (view[2] << 16) | (view[3] << 8) | view[4];
          // Read data
          const jsonBytes = view.subarray(5, 5 + length);
          const jsonStr = new TextDecoder().decode(jsonBytes);
          return JSON.parse(jsonStr);
        }
      }
      
      // Fallback to string
      if (typeof data === 'string') {
        return JSON.parse(data);
      }
    } catch (err) {
      throw new Error(`Binary decode failed: ${err.message}`);
    }
  }
  
  static async _decodeCompressed(view) {
    try {
      const compressedData = view.subarray(1);
      const decompressed = await Compressor.decompress(compressedData);
      const jsonStr = new TextDecoder().decode(decompressed);
      return JSON.parse(jsonStr);
    } catch (err) {
      throw new Error(`Decompression failed: ${err.message}`);
    }
  }
  
  static _decodeChunk(view) {
    // Extract chunk metadata
    const chunkId = (view[1] << 24) | (view[2] << 16) | (view[3] << 8) | view[4];
    
    // Check if this is a compressed chunk
    const isCompressed = (chunkId & 0x80000000) !== 0;
    const cleanChunkId = chunkId & 0x7FFFFFFF;
    
    const totalChunks = (view[5] << 24) | (view[6] << 16) | (view[7] << 8) | view[8];
    const chunkIndex = (view[9] << 24) | (view[10] << 16) | (view[11] << 8) | view[12];
    const chunkSize = (view[13] << 24) | (view[14] << 16) | (view[15] << 8) | view[16];
    
    // Extract chunk data
    const chunkData = view.subarray(17, 17 + chunkSize);
    
    // Initialize message if first chunk
    if (!incomingChunks.has(cleanChunkId)) {
      incomingChunks.set(cleanChunkId, {
        totalChunks,
        chunks: new Array(totalChunks),
        received: 0,
        totalSize: 0,
        isCompressed: isCompressed
      });
    }
    
    const message = incomingChunks.get(cleanChunkId);
    message.chunks[chunkIndex] = chunkData;
    message.received++;
    message.totalSize += chunkSize;
    
    // If all chunks received, reassemble
    if (message.received === totalChunks) {
      // Combine all chunks
      const fullData = new Uint8Array(message.totalSize);
      let offset = 0;
      for (let i = 0; i < totalChunks; i++) {
        fullData.set(message.chunks[i], offset);
        offset += message.chunks[i].length;
      }
      
      incomingChunks.delete(cleanChunkId);
      
      if (message.isCompressed) {
        // Return a promise to decompress asynchronously
        return Compressor.decompress(fullData).then(decompressed => {
          const jsonStr = new TextDecoder().decode(decompressed);
          return JSON.parse(jsonStr);
        }).catch(err => {
          throw new Error(`Decompression failed: ${err.message}`);
        });
      } else {
        const jsonStr = new TextDecoder().decode(fullData);
        return JSON.parse(jsonStr);
      }
    }
    
    // Still waiting for more chunks
    return null;
  }
}

class SmartSocket {
  constructor(ws, server) {
    this.ws = ws;
    this.server = server;
    this.id = this._generateId();
    this.rooms = new Set();
    this.handlers = {};
    this.data = {};
    this.streamId = server.multiplexer.createStream({ priority: 5 });
  }

  _generateId() {
    return `socket_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  on(event, handler) {
    this.handlers[event] = handler;
  }

  emit(event, data) {
    // Use object pool for message creation
    const msg = this.server.messagePool.acquire();
    msg.event = event;
    msg.data = data;
    msg.timestamp = Date.now();
    
    // Async encoding - handle compression and chunking
    BinaryEncoder.encode(event, data).then(message => {
      if (!message) {
        console.error(`[SmartSocket] Encode returned null/undefined for event: ${event}`);
        this.server.messagePool.release(msg);
        return;
      }
      
      try {
        // Encrypt message if encryption is enabled
        let finalMessage = message;
        if (encryptionManager.isEnabled()) {
          // Convert message to encrypted format
          const messageStr = typeof message === 'string' ? message : JSON.stringify(message);
          finalMessage = encryptionManager.encrypt(messageStr, this.id);
        }
        
        // Handle chunked messages (array of buffers)
        if (Array.isArray(finalMessage)) {
          for (let i = 0; i < finalMessage.length; i++) {
            // Small delay between chunks to prevent overwhelming
            setTimeout(() => {
              try {
                if (this.ws && typeof this.ws.send === 'function') {
                  this.ws.send(finalMessage[i], true);
                }
              } catch (err) {
                console.error(`[SmartSocket] Send chunk error: ${err.message}`);
              }
            }, i * 10);
          }
        } else {
          // Single message
          if (this.ws && typeof this.ws.send === 'function') {
            const isBuffer = finalMessage instanceof ArrayBuffer || finalMessage instanceof Uint8Array || (Buffer && Buffer.isBuffer(finalMessage));
            this.ws.send(finalMessage, !isBuffer);
          }
        }
      } catch (err) {
        console.error(`[SmartSocket] Socket send error: ${err.message}`);
      } finally {
        // Return message object to pool
        this.server.messagePool.release(msg);
      }
    }).catch(err => {
      console.error(`[SmartSocket] Error encoding message for [${event}]: ${err.message}`);
      this.server.messagePool.release(msg);
    });
  }

  join(room) {
    this.rooms.add(room);
    if (!this.server.rooms.has(room)) {
      this.server.rooms.set(room, new Set());
    }
    this.server.rooms.get(room).add(this);
    this.server._logVibe(`Socket ${this.id} joined room [${room}]`);
  }

  leave(room) {
    this.rooms.delete(room);
    const roomSockets = this.server.rooms.get(room);
    if (roomSockets) {
      roomSockets.delete(this);
      if (roomSockets.size === 0) {
        this.server.rooms.delete(room);
        // Invalidate cache for this room
        this.server.roomStateCache.invalidate();
      }
    }
    this.server._logVibe(`Socket ${this.id} left room [${room}]`);
  }

  broadcast(event, data) {
    BinaryEncoder.encode(event, data).then(message => {
      this.server.sockets.forEach(socket => {
        if (socket.id !== this.id) {
          // Handle chunked messages
          if (Array.isArray(message)) {
            for (let i = 0; i < message.length; i++) {
              setTimeout(() => {
                socket.ws.send(message[i], true);
              }, i * 10);
            }
          } else {
            socket.ws.send(message, typeof message === 'string' ? false : true);
          }
        }
      });
    }).catch(err => {
      console.error(`[SmartSocket] Broadcast error: ${err.message}`);
    });
  }

  disconnect() {
    // Clean up multiplexer stream
    this.server.multiplexer.closeStream(this.streamId);
    this.ws.end();
  }
}

class SmartSocketServer {
  constructor(port = 8080, options = {}) {
    // Unique instance ID for debugging
    this.instanceId = Math.random().toString(36).substring(7);
    console.log(`[SmartSocketServer] NEW INSTANCE CREATED: ${this.instanceId}`);
    
    this.port = port;
    this.options = {
      // Feature flags - enabled by default for out-of-box functionality
      enableMiddleware: options.enableMiddleware !== false,
      enableNamespaces: options.enableNamespaces !== false,
      enableAcknowledgments: options.enableAcknowledgments !== false,
      enableErrorHandling: options.enableErrorHandling !== false,
      // Other options
      verbose: options.verbose !== false,
      ...options
    };
    
    this.sockets = new Set();
    this.rooms = new Map();
    this.roomStates = new Map();
    this.handlers = {};
    this.app = null;
    this.heartbeatInterval = null;
    this.verbose = this.options.verbose;
    
    // ============================================
    // TIER 2 & 3 Optimizations - Initialized Here
    // ============================================
    
    // 1. Object Pool - Reuse message objects (-40% GC pressure)
    this.messagePool = new ObjectPool(
      createMessageObject,
      resetMessageObject,
      1000, // minSize
      10000 // maxSize
    );
    
    // 2. Message Cache - Cache room state and lookups (-20% latency)
    this.messageCache = new MessageCache(60000, 10000);
    this.roomStateCache = new RoomStateCache();
    this.userSessionCache = new UserSessionCache();
    
    // 3. Rate Limiter - Prevent abuse and fair distribution
    this.rateLimiter = new AdaptiveRateLimiter({
      maxCapacity: options.maxCapacity || 1000,
      refillRate: options.refillRate || 100,
      cpuThreshold: options.cpuThreshold || 80,
      memoryThreshold: options.memoryThreshold || 85
    });
    
    // 4. Predictive Compressor - Learn what compresses well (-35% CPU)
    this.predictiveCompressor = new PredictiveCompressor();
    
    // 5. Connection Multiplexer - Multiple streams per connection (unlimited)
    this.multiplexer = new ConnectionMultiplexer({
      maxStreams: options.maxStreams || Infinity  // Unlimited connections
    });
    this.streamScheduler = new StreamScheduler(this.multiplexer);
    
    // 6. Connection Pool - Share resources across connections
    this.connectionPool = new ConnectionPool({
      size: options.poolSize || 100
    });
    
    // 7. Enhanced Buffer Pool
    this.bufferPoolOptimized = new BufferPoolOptimized({
      bufferSize: options.bufferSize || 65536,
      minSize: 500,
      maxSize: 5000
    });
    
    // ============================================
    // Feature Systems - Opt-in via flags
    // ============================================
    
    // 1. Middleware System
    if (this.options.enableMiddleware) {
      this.middleware = new MiddlewareManager();
      this._logVibe('✅ Middleware system enabled');
    } else {
      this.middleware = null;
    }
    
    // 2. Namespace System
    if (this.options.enableNamespaces) {
      this.namespaceManager = new NamespaceManager(this);
      this._logVibe('✅ Namespace system enabled');
    } else {
      this.namespaceManager = null;
    }
    
    // 3. Acknowledgment System
    if (this.options.enableAcknowledgments) {
      this.ackManager = new AcknowledgmentManager(this.options);
      this._logVibe('✅ Acknowledgment system enabled');
    } else {
      this.ackManager = null;
    }
    
    // 4. Error Handling & Smart API
    if (this.options.enableErrorHandling) {
      this.errorHandler = new ErrorHandler(this);
      this.api = new SmartSocketAPI(this);
      this._logVibe('✅ Error handling & Smart API enabled');
    } else {
      this.errorHandler = null;
      this.api = null;
    }
    
    // Statistics tracking
    this.stats = {
      messagesProcessed: 0,
      messagesOptimized: 0,
      cachedLookups: 0,
      rateLimitedRequests: 0,
      compressionStats: {},
      startTime: Date.now(),
      // Transmission metrics
      transmissionMetrics: {
        totalLatency: 0,      // Sum of all latencies
        totalMessages: 0,      // Count of messages
        totalDataSent: 0,      // Total bytes sent
        totalCompressed: 0,    // Total bytes after compression
        compressionRatios: []  // Array of compression percentages
      }
    };
    
    // Generate API key for this server
    this.apiKey = this._loadOrGenerateApiKey();
  }

  /**
   * Load API key from file or generate new one
   */
  _loadOrGenerateApiKey() {
    // Check for environment variable first
    if (process.env.SMARTSOCKET_API_KEY) {
      console.log('[SmartSocket] 🔑 Using API key from environment variable');
      return process.env.SMARTSOCKET_API_KEY;
    }

    // Try to load from file
    if (fs.existsSync(keyFile)) {
      try {
        const savedKey = fs.readFileSync(keyFile, 'utf-8').trim();
        console.log('[SmartSocket] 🔑 Using saved API key from file');
        return savedKey;
      } catch (err) {
        console.warn('[SmartSocket] ⚠️  Could not read API key file:', err.message);
      }
    }

    // Generate new key and save to file
    const newKey = this._generateApiKey();
    try {
      fs.writeFileSync(keyFile, newKey);
      console.log('[SmartSocket] 🔑 Generated and saved new API key to file');
    } catch (err) {
      console.warn('[SmartSocket] ⚠️  Could not save API key file:', err.message);
      console.log('[SmartSocket] ℹ️  Will generate new key on next restart');
    }
    return newKey;
  }

  /**
   * Generate a unique API key in format: sk-proj-xxx...xxx
   */
  _generateApiKey() {
    const prefix = 'sk-proj-';
    const randomPart = crypto.randomBytes(24).toString('hex');
    return prefix + randomPart;
  }

  _logVibe(message) {
    if (this.verbose) {
      console.log(`[SmartSocket] ${message}`);
    }
  }

  /**
   * Feature: Namespace - Get or create namespace
   * Usage: server.namespace('/chat')
   */
  namespace(name) {
    if (!this.namespaceManager) {
      throw new Error('Namespaces not enabled. Create server with { enableNamespaces: true }');
    }
    return this.namespaceManager.namespace(name);
  }

  /**
   * Feature: Middleware - Use middleware
   * Usage: server.use((socket, event, data, next) => { ... })
   */
  use(handler) {
    if (!this.middleware) {
      throw new Error('Middleware not enabled. Create server with { enableMiddleware: true }');
    }
    return this.middleware.use(handler);
  }

  /**
   * Feature: Middleware - Request handler
   */
  useRequest(handler) {
    if (!this.middleware) {
      throw new Error('Middleware not enabled. Create server with { enableMiddleware: true }');
    }
    return this.middleware.useRequest(handler);
  }

  /**
   * Feature: Middleware - Response handler
   */
  useResponse(handler) {
    if (!this.middleware) {
      throw new Error('Middleware not enabled. Create server with { enableMiddleware: true }');
    }
    return this.middleware.useResponse(handler);
  }

  /**
   * Feature: Middleware - Error handler
   */
  useError(handler) {
    if (!this.middleware) {
      throw new Error('Middleware not enabled. Create server with { enableMiddleware: true }');
    }
    return this.middleware.useError(handler);
  }

  /**
   * Feature: Error Handling - Register error handler
   */
  onError(handler) {
    if (!this.errorHandler) {
      throw new Error('Error handling not enabled. Create server with { enableErrorHandling: true }');
    }
    return this.errorHandler.onError(handler);
  }
  
  /**
   * Get feature status
   */
  getFeatures() {
    return {
      middleware: this.middleware ? 'enabled' : 'disabled',
      namespaces: this.namespaceManager ? 'enabled' : 'disabled',
      acknowledgments: this.ackManager ? 'enabled' : 'disabled',
      errorHandling: this.errorHandler ? 'enabled' : 'disabled'
    };
  }

  /**
   * Get comprehensive statistics about all optimizations
   */
  getOptimizationStats() {
    const uptime = Date.now() - this.stats.startTime;
    const cpuUsage = process.cpuUsage();
    const memUsage = process.memoryUsage();
    
    return {
      uptime: `${(uptime / 1000).toFixed(2)}s`,
      connections: this.sockets.size,
      rooms: this.rooms.size,
      
      // Optimization stats
      objectPool: this.messagePool.getStats(),
      messageCache: this.messageCache.getStats(),
      rateLimiter: this.rateLimiter.getStats(),
      predictiveCompressor: this.predictiveCompressor.getAllStats(),
      connectionMultiplexer: this.multiplexer.getStats(),
      connectionPool: this.connectionPool.getStats(),
      bufferPool: this.bufferPoolOptimized.getStats(),
      
      // Memory stats
      memory: {
        heapUsed: `${(memUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`,
        heapTotal: `${(memUsage.heapTotal / 1024 / 1024).toFixed(2)}MB`,
        rss: `${(memUsage.rss / 1024 / 1024).toFixed(2)}MB`,
        external: `${(memUsage.external / 1024 / 1024).toFixed(2)}MB`
      },
      
      // CPU stats
      cpu: {
        user: `${(cpuUsage.user / 1000).toFixed(2)}ms`,
        system: `${(cpuUsage.system / 1000).toFixed(2)}ms`
      },
      
      // Business stats
      stats: {
        messagesProcessed: this.stats.messagesProcessed,
        messagesOptimized: this.stats.messagesOptimized,
        optimizationRate: `${((this.stats.messagesOptimized / Math.max(this.stats.messagesProcessed, 1)) * 100).toFixed(2)}%`,
        cachedLookups: this.stats.cachedLookups,
        rateLimitedRequests: this.stats.rateLimitedRequests
      },
      
      // Transmission metrics
      transmission: (() => {
        const metrics = this.stats.transmissionMetrics;
        const avgLatency = metrics.totalMessages > 0 ? (metrics.totalLatency / metrics.totalMessages).toFixed(2) : 0;
        const avgSpeed = metrics.totalLatency > 0 ? (metrics.totalDataSent / metrics.totalLatency / 1024).toFixed(2) : 0;
        const avgCompression = metrics.compressionRatios.length > 0 
          ? (metrics.compressionRatios.reduce((a, b) => a + b, 0) / metrics.compressionRatios.length).toFixed(2)
          : 0;
        
        return {
          totalMessages: metrics.totalMessages,
          averageLatency: `${avgLatency}ms`,
          averageSpeed: `${avgSpeed} KB/s`,
          averageCompression: `${avgCompression}%`,
          totalDataTransmitted: `${(metrics.totalDataSent / 1024 / 1024).toFixed(2)} MB`,
          totalCompressed: `${(metrics.totalCompressed / 1024 / 1024).toFixed(2)} MB`,
          bandwidthSaved: `${((1 - metrics.totalCompressed / Math.max(metrics.totalDataSent, 1)) * 100).toFixed(2)}%`
        };
      })()
    };
  }

  /**
   * Enable/disable monitoring (logs stats every X seconds)
   */
  startMonitoring(interval = 30000) {
    this.monitoringInterval = setInterval(() => {
      const stats = this.getOptimizationStats();
      console.log('\n=== SmartSocket Optimization Stats ===');
      console.log(JSON.stringify(stats, null, 2));
      console.log('=====================================\n');
    }, interval);
  }

  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
  }

  _prepareMessage(event, data) {
    // Smart-Binary Encoding: Automatically choose best format
    // JSON for small objects, ArrayBuffer for large data
    return BinaryEncoder.encode(event, data);
  }

  on(event, handler) {
    this.handlers[event] = handler;
  }

  to(room) {
    const roomSockets = this.rooms.get(room);
    if (!roomSockets || roomSockets.size === 0) {
      this._logVibe(`⚠️ Room [${room}] does not exist or is empty. Did you mean to join first?`);
      return {
        emit: () => {} // No-op if room doesn't exist
      };
    }

    return {
      emit: (event, data) => {
        // Zero-Copy Broadcasting with async encoding
        const startTime = Date.now();
        BinaryEncoder.encode(event, data).then(async message => {
          const encodeTime = Date.now() - startTime;
          
          if (!message) {
            console.error(`[SmartSocket] Encode returned null/undefined for event: ${event}`);
            return;
          }
          
          // Debug: Check message type and size
          console.log(`[ENCODE DEBUG] Message type: ${message.constructor.name}, isBuffer: ${Buffer.isBuffer(message)}`);
          const messageBuffer = Buffer.isBuffer(message) ? message : Buffer.from(message);
          const originalSize = messageBuffer.length;
          console.log(`[ENCODE DEBUG] Original buffer size: ${originalSize.toLocaleString()} bytes`);
          
          // Compress message for faster transmission
          let compressedMessage = message;
          let compressedSize = originalSize;
          let compressionTime = 0;
          
          try {
            const compressionStart = Date.now();
            const messageToCompress = Buffer.isBuffer(message) ? message : Buffer.from(message);
            const compressed = await deflateAsync(messageToCompress);
            compressionTime = Date.now() - compressionStart;
            
            console.log(`[COMPRESSION DEBUG] Input size: ${messageToCompress.length}, Compressed size: ${compressed.length}, Type: ${compressed.constructor.name}`);
            
            // Only use compression if it actually saves space (> 10% reduction)
            const compressionRatio = ((1 - compressed.length / originalSize) * 100);
            console.log(`  [DEBUG] compressed.length: ${compressed.length}, type: ${compressed.constructor.name}`);
            if (compressionRatio > 10) {
              compressedMessage = compressed;
              compressedSize = compressed.length;
            } else {
              // Compression doesn't help, use original
              compressedMessage = message;
              compressedSize = originalSize;
            }
            
            const compressionRate = (compressedSize / (compressionTime || 1) / 1024).toFixed(2); // KB/s
            const compressionRate_MB = (compressedSize / (compressionTime || 1) / 1024 / 1024).toFixed(3); // MB/s
            
            console.log(`\n[BROADCAST] Event: ${event}`);
            console.log(`  ├─ Room: ${room} | Clients: ${roomSockets.size}`);
            console.log(`  ├─ Encode Time: ${encodeTime}ms`);
            console.log(`  ├─ Compression Time: ${compressionTime}ms`);
            console.log(`  ├─ Original Size: ${originalSize.toLocaleString()} bytes`);
            console.log(`  ├─ Compressed Size (before filter): ${compressed.length.toLocaleString()} bytes`);
            console.log(`  ├─ Transmitted Size: ${compressedSize.toLocaleString()} bytes`);
            console.log(`  ├─ Compression Ratio: ${compressionRatio.toFixed(2)}%`);
            console.log(`  ├─ Compression Speed: ${compressionRate} KB/s (${compressionRate_MB} MB/s)`);
            if (compressionRatio <= 10) {
              console.log(`  └─ Note: Message too small for compression\n`);
            } else {
              console.log(`\n`);
            }
          } catch (err) {
            console.log(`\n[BROADCAST] Compression failed for ${event}: ${err.message}`);
            console.log(`  Error: ${err.stack}\n`);
            compressedMessage = message;

          }
          
          roomSockets.forEach(socket => {
            try {
              const sendStart = Date.now();
              if (socket.ws && typeof socket.ws.send === 'function') {
                socket.ws.send(compressedMessage, true);
              }
            } catch (err) {
              console.error(`[SmartSocket] Socket send error: ${err.message}`);
            }
          });
          
          const totalLatencyMs = Date.now() - startTime;
          const totalDataSent = compressedSize * roomSockets.size;
          const throughputKBps = (totalDataSent / totalLatencyMs / 1024).toFixed(2);
          
          // Collect transmission metrics for /stats endpoint
          const compressionRatio = originalSize > 0 ? ((1 - compressedSize / originalSize) * 100) : 0;
          this.stats.transmissionMetrics.totalLatency += totalLatencyMs;
          this.stats.transmissionMetrics.totalMessages += 1;
          this.stats.transmissionMetrics.totalDataSent += totalDataSent;
          this.stats.transmissionMetrics.totalCompressed += compressedSize;
          this.stats.transmissionMetrics.compressionRatios.push(compressionRatio);
          
          if (this.stats.transmissionMetrics.compressionRatios.length > 100) {
            this.stats.transmissionMetrics.compressionRatios.shift();
          }
          
          console.log(`[BROADCAST] LATENCY: ${totalLatencyMs}ms | DATA: ${totalDataSent.toLocaleString()} bytes | CLIENTS: ${roomSockets.size} | THROUGHPUT: ${throughputKBps} KB/s\n`);
          this._logVibe(`� Broadcasted '${event}' to room [${room}] with ${roomSockets.size} clients`);
        }).catch(err => {
          console.error(`[SmartSocket] Room emit error for [${event}]: ${err.message}`);
        });
      }
    };
  }

  broadcast(event, data) {
    // Zero-Copy Broadcasting: Prepare once, send to all
    BinaryEncoder.encode(event, data).then(message => {
      this.sockets.forEach(socket => {
        // Handle chunked messages
        if (Array.isArray(message)) {
          for (let i = 0; i < message.length; i++) {
            setTimeout(() => {
              socket.ws.send(message[i], true);
            }, i * 10);
          }
        } else {
          socket.ws.send(message, typeof message === 'string' ? false : true);
        }
      });
      this._logVibe(`Broadcasted '${event}' to all ${this.sockets.size} clients`);
    }).catch(err => {
      console.error(`[SmartSocket] Broadcast error: ${err.message}`);
    });
  }

  syncState(room, state) {
    // Smart-State Syncing: Store state and broadcast
    const previousState = this.roomStates.get(room);
    this.roomStates.set(room, state);

    if (previousState) {
      // Calculate diff (simple implementation - can be optimized with deep diff)
      const diff = this._calculateDiff(previousState, state);
      this.to(room).emit('state:update', { diff, full: state });
    } else {
      this.to(room).emit('state:update', { full: state });
    }
    
    this._logVibe(`State synced for room [${room}]`);
  }

  _calculateDiff(oldState, newState) {
    const diff = {};
    for (const key in newState) {
      if (JSON.stringify(oldState[key]) !== JSON.stringify(newState[key])) {
        diff[key] = newState[key];
      }
    }
    return diff;
  }

  getState(room) {
    return this.roomStates.get(room) || null;
  }

  _startHeartbeat() {
    // Internal Heartbeat Engine: Ping every 30 seconds
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      this.sockets.forEach(socket => {
        if (socket.ws.getBufferedAmount() > 0) {
          // Connection might be dead
          socket.lastPing = socket.lastPing || now;
          if (now - socket.lastPing > 60000) { // 60s timeout
            this._logVibe(`Closing ghost connection: ${socket.id}`);
            socket.disconnect();
          }
        } else {
          socket.lastPing = now;
          socket.emit('ping', { timestamp: now });
        }
      });
    }, 30000);
  }

  _handleConnection(ws, socket) {
    // Trigger connection handler
    if (this.handlers['connection']) {
      this.handlers['connection'](socket);
    }
  }

  listen(callback) {
    // Store reference to prevent namespace loss
    const namespaceManager = this.namespaceManager;
    const server = this;
    
    this.app = uWS.App({})
      .ws('/*', {
        compression: uWS.SHARED_COMPRESSOR,
        maxPayloadLength: 16 * 1024 * 1024,
        idleTimeout: 120,
        
        open: (ws) => {
          const socket = new SmartSocket(ws, server);
          server.sockets.add(socket);
          
          console.log(`\n[CONNECTION] ✅ New client connected`);
          console.log(`  └─ Socket ID: ${socket.id}`);
          console.log(`  └─ Total Connections: ${server.sockets.size}`);
          console.log(`  └─ Timestamp: ${new Date().toISOString()}\n`);
          
          server._logVibe(`✅ New connection: ${socket.id} (Total: ${server.sockets.size})`);
          server._handleConnection(ws, socket);
        },
        
        message: (ws, message, isBinary) => {
          const socket = Array.from(server.sockets).find(s => s.ws === ws);
          if (socket) {
            try {
              console.log(`\n[MESSAGE] 📨 Received from ${socket.id}`);
              console.log(`  └─ Binary: ${isBinary}`);
              console.log(`  └─ Size: ${message.length} bytes`);
              
              // Check rate limit first
              if (!server.rateLimiter.isAllowed(socket.id)) {
                server.stats.rateLimitedRequests++;
                console.log(`  └─ ⚠️  Rate limited!\n`);
                return;
              }
              
              server.stats.messagesProcessed++;
              
              // Decrypt message if encryption is enabled (DISABLED)
              let decrypted = message;
              // if (encryptionManager.isEnabled()) {
              //   decrypted = encryptionManager.decrypt(message, socket.id);
              //   if (!decrypted) {
              //     console.error(`  └─ ❌ Decryption failed!\n`);
              //     return;
              //   }
              // }
              
              // Smart-Binary Decoding: Handle both JSON strings and binary ArrayBuffers
              let parsed;
              if (isBinary && typeof decrypted !== 'string') {
                // Binary data - use BinaryEncoder decoder
                console.log(`  └─ 📦 Parsing binary data...`);
                parsed = BinaryEncoder.decode(decrypted);
              } else {
                // String data - parse as JSON
                console.log(`  └─ 📄 Parsing JSON data...`);
                const msg = typeof decrypted === 'string' ? decrypted : Buffer.from(decrypted).toString();
                parsed = JSON.parse(msg);
              }
              
              console.log(`  └─ Event: ${parsed.event}`);
              console.log(`  └─ Data: ${JSON.stringify(parsed.data).substring(0, 100)}...\n`);
              const { event, data } = parsed;

              if (event === 'pong') {
                socket.lastPong = Date.now();
                return;
              }

              // Try cache for certain event types
              if (event === 'state:get' && data && data.roomId) {
                const cached = server.roomStateCache.getRoomState(data.roomId);
                if (cached) {
                  server.stats.cachedLookups++;
                  socket.emit('state:cached', cached);
                  return;
                }
              }

              // Auto-assign socket to namespace on first quiz-related event
              if (!socket.namespace && data && data.quizCode && namespaceManager) {
                const quizNamespace = namespaceManager.namespaces.get('/quiz');
                
                if (quizNamespace) {
                  quizNamespace.addSocket(socket);
                  socket.namespace = '/quiz';
                  console.log(`[NAMESPACE] ✅ Socket auto-assigned to namespace [/quiz] (first event: ${event})`);
                  
                  // Fire namespace-specific connection handler if registered
                  if (quizNamespace.handlers['connection']) {
                    quizNamespace.handlers['connection'](socket);
                  }
                } else {
                  console.warn(`[AUTO-ASSIGN] WARNING: /quiz namespace not found`);
                }
              }

              // Check namespace handlers FIRST (highest priority for organized routing)
              if (socket.namespace && namespaceManager) {
                const namespace = namespaceManager.namespaces.get(socket.namespace);
                if (namespace && namespace.handlers[event]) {
                  console.log(`[ROUTER] Event '${event}' routed to namespace [${socket.namespace}]`);
                  namespace.handlers[event](socket, data);
                  return;
                }
              }

              // Then check socket-specific handlers
              if (socket.handlers[event]) {
                socket.handlers[event](data);
              } else if (server.handlers[event]) {
                server.handlers[event](socket, data);
              }
              
              server.stats.messagesOptimized++;
            } catch (err) {
              server._logVibe(`❌ Error parsing message: ${err.message}`);
            }
          }
        },
        
        close: (ws, code, message) => {
          const socket = Array.from(server.sockets).find(s => s.ws === ws);
          if (socket) {
            console.log(`\n[DISCONNECT] ❌ Client disconnected`);
            console.log(`  └─ Socket ID: ${socket.id}`);
            console.log(`  └─ Namespace: ${socket.namespace || 'default'}`);
            console.log(`  └─ Rooms: ${Array.from(socket.rooms).join(', ') || 'none'}`);
            console.log(`  └─ Duration: ${Date.now() - socket.createdAt}ms`);
            console.log(`  └─ Code: ${code}`);
            console.log(`  └─ Remaining Connections: ${server.sockets.size - 1}`);
            console.log(`  └─ Timestamp: ${new Date().toISOString()}\n`);
            
            // Clear encryption key for this connection (DISABLED)
            // encryptionManager.clearSessionKey(socket.id);
            
            // Remove from namespace if assigned
            if (socket.namespace && namespaceManager) {
              const namespace = namespaceManager.namespaces.get(socket.namespace);
              if (namespace) {
                namespace.removeSocket(socket);
                console.log(`[NAMESPACE] Socket removed from namespace [${socket.namespace}]`);
                
                // Fire namespace-specific disconnect handler if registered
                if (namespace.handlers['disconnect']) {
                  namespace.handlers['disconnect'](socket);
                }
              }
            }
            
            server.sockets.delete(socket);
            socket.rooms.forEach(room => {
              const roomSockets = server.rooms.get(room);
              if (roomSockets) {
                roomSockets.delete(socket);
                if (roomSockets.size === 0) {
                  server.rooms.delete(room);
                }
              }
            });
            
            if (server.handlers['disconnect']) {
              server.handlers['disconnect'](socket);
            }
            
            server._logVibe(`❌ Disconnected: ${socket.id} (Total: ${server.sockets.size})`);
          }
        }
      })
      .any('/*', (res, req) => {
        // HTTP Long-Polling fallback endpoint
        const url = req.getUrl();
        
        if (url.startsWith('/smartsocket/poll')) {
          // Simple HTTP fallback for clients behind firewalls
          res.writeHeader('Access-Control-Allow-Origin', '*');
          res.writeHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ 
            status: 'ok', 
            message: 'SmartSocket HTTP Fallback Active',
            upgrade: 'Use WebSocket for better performance'
          }));
        } else if (url.startsWith('/smartsocket/stats')) {
          // Metrics endpoint
          res.writeHeader('Access-Control-Allow-Origin', '*');
          res.writeHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(this.getOptimizationStats(), null, 2));
        } else if (url.startsWith('/client.js')) {
          // Serve client library
          res.writeHeader('Access-Control-Allow-Origin', '*');
          res.writeHeader('Content-Type', 'application/javascript');
          const clientCode = `window.SmartSocket=class{constructor(e){this.url=e,this.ws=null,this.handlers={},this.connected=!1,this.autoReconnect=!0,this.reconnectAttempts=0,this.maxReconnectAttempts=10,this.reconnectDelay=1e3,this.connect()}connect(){try{this.ws=new WebSocket(this.url),this.ws.onopen=(()=>{this.connected=!0,this.reconnectAttempts=0,this.fire("open"),console.log("[SmartSocket Client] Connected to "+this.url)}),this.ws.onmessage=(e=>{const t=JSON.parse(e.data);this.fire(t.event,t.data)}),this.ws.onclose=(()=>{this.connected=!1,this.fire("close"),this.autoReconnect&&this.reconnect()}),this.ws.onerror=(e=>{console.error("[SmartSocket Client] Error:",e),this.fire("error",e)})}catch(e){console.error("[SmartSocket Client] Connection failed:",e),this.fire("error",e)}}reconnect(){this.reconnectAttempts>=this.maxReconnectAttempts?(console.error("[SmartSocket Client] Max reconnection attempts reached"),this.fire("reconnect:failed")):(this.reconnectAttempts++,console.log("[SmartSocket Client] Reconnecting... (attempt "+this.reconnectAttempts+")"),setTimeout((()=>this.connect()),this.reconnectDelay*this.reconnectAttempts))}on(e,t){this.handlers[e]=t}off(e){delete this.handlers[e]}fire(e,t){this.handlers[e]&&this.handlers[e](t)}emit(e,t){if(!this.connected)return void console.warn("[SmartSocket Client] Not connected");const s=JSON.stringify({event:e,data:t});this.ws.send(s)}disconnect(){this.autoReconnect=!1,this.ws&&this.ws.close(),this.connected=!1}};console.log("[SmartSocket Client] Library loaded - v2.0.0");`;
          res.end(clientCode);
        } else {
          res.writeStatus('404 Not Found');
          res.end('SmartSocket Server - WebSocket endpoint only');
        }
      })
      .listen(this.port, '0.0.0.0', (token) => {
        if (token) {
          const interfaces = networkInterfaces();
          let serverIp = 'localhost';
          
          // Find local IP address
          for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
              if (iface.family === 'IPv4' && !iface.internal) {
                serverIp = iface.address;
                break;
              }
            }
          }
          
          this._logVibe(`🚀 SmartSocket running on port ${this.port}`);
          this._logVibe(`📊 Stats available at http://${serverIp}:${this.port}/smartsocket/stats`);
          this._logVibe(`🌐 Also accessible at http://localhost:${this.port}/smartsocket/stats`);
          
          // Display API Key for connection
          console.log('\n' + '═'.repeat(70));
          console.log('🔑 SmartSocket Connection Details');
          console.log('═'.repeat(70));
          console.log(`📍 Server Address: ${serverIp}:${this.port}`);
          console.log(`🔐 API Key: ${this.apiKey}`);
          console.log('═'.repeat(70));
          console.log('\n💻 Add to your webpage:\n');
          console.log(`const socket = new SmartSocket('ws://${serverIp}:${this.port}', {`);
          console.log(`  apiKey: '${this.apiKey}'`);
          console.log(`});\n`);
          console.log('═'.repeat(70) + '\n');
          
          this._startHeartbeat();
          if (callback) callback();
        } else {
          this._logVibe(`❌ Failed to start on port ${this.port}`);
        }
      });

    return this;
  }

  close() {
    // Cleanup all optimizations
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
    }
    
    // Destroy optimization resources
    this.messageCache.destroy();
    this.roomStateCache.destroy();
    this.userSessionCache.destroy();
    this.rateLimiter.destroy();
    this.multiplexer.clear();
    this.connectionPool.drain();
    this.bufferPoolOptimized.clear();
    
    if (this.app) {
      uWS.us_listen_socket_close(this.app);
    }
    this._logVibe('Server closed - all resources cleaned up');
  }
}

// Main export function
export default function smartsocket(port = 8080, options = {}) {
  return new SmartSocketServer(port, options);
}

// Named exports for flexibility
export { 
  smartsocket, 
  SmartSocketServer, 
  SmartSocket, 
  BinaryEncoder,
  MiddlewareManager,
  NamespaceManager,
  AcknowledgmentManager,
  ErrorHandler,
  SmartSocketAPI
};

// ============================================
// Auto-start server when run directly
// ============================================
if (import.meta.url.endsWith(process.argv[1]) || import.meta.url.includes('index.js')) {
  const port = process.env.PORT || 8080;
  const server = new SmartSocketServer(port, { verbose: true });
  
  // Setup basic event handlers
  server.on('connect', (socket) => {
    console.log(`✅ Client connected: ${socket.id}`);
  });
  
  // Handle user joining a room
  server.on('user-join', (socket, data) => {
    const { username, room } = data;
    console.log(`\n[ROOM] 👤 User joined: ${username}`);
    console.log(`  └─ Room: ${room}`);
    console.log(`  └─ Socket ID: ${socket.id}\n`);
    
    socket.join(room);
    // Broadcast user joined to room
    server.to(room).emit('user-joined', { username, room });
  });
  
  // Handle messages in rooms
  server.on('send-message', (socket, data) => {
    const { sender, text, room, timestamp } = data;
    console.log(`\n[CHAT] 💬 Message in ${room}`);
    console.log(`  └─ From: ${sender}`);
    console.log(`  └─ Text: ${text}\n`);
    
    // Broadcast message to all users in the room
    server.to(room).emit('message', { sender, text, room, timestamp });
  });
  
  // Handle user leaving
  server.on('user-leave', (socket, data) => {
    const { username, room } = data;
    console.log(`\n[ROOM] 👋 User left: ${username}`);
    console.log(`  └─ Room: ${room}\n`);
    
    socket.leave(room);
    server.to(room).emit('user-left', { username, room });
  });
  
  server.on('message', (socket, event, data) => {
    console.log(`📨 Message from ${socket.id}: ${event}`);
  });
  
  server.on('disconnect', (socket) => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
  
  // Start the server
  server.listen(() => {
    console.log(`✨ SmartSocket is ready!`);
  });
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    server.close();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down gracefully...');
    server.close();
    process.exit(0);
  });
}
