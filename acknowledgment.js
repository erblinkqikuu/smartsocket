/**
 * SmartSocket Acknowledgment System - Confirmation and reliability
 * 
 * Usage:
 * socket.emit('save-data', { name: 'John' }, (ack) => {
 *   console.log('Server received:', ack);
 * });
 * 
 * Server:
 * socket.on('save-data', (data, ack) => {
 *   // ... save data ...
 *   ack({ success: true, id: 123 }); // Callback fired on client
 * });
 * 
 * Disable: Create server/client with { enableAcknowledgments: false }
 */

export class AcknowledgmentManager {
  constructor(options = {}) {
    this.acks = new Map(); // ackId -> { resolve, reject, timeout }
    this.ackCounter = 0;
    this.ackTimeout = options.ackTimeout || 30000; // 30 seconds default
    this.maxPendingAcks = options.maxPendingAcks || 10000;
    this.retryAttempts = options.retryAttempts || 3;
    this.retryDelay = options.retryDelay || 1000;
    this.metrics = {
      sent: 0,
      received: 0,
      timeout: 0,
      failed: 0
    };
  }

  /**
   * Create acknowledgment request
   */
  createAck() {
    const ackId = ++this.ackCounter;
    
    if (this.acks.size >= this.maxPendingAcks) {
      throw new Error(`Too many pending acknowledgments (${this.acks.size})`);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.acks.delete(ackId);
        this.metrics.timeout++;
        reject(new Error(`Acknowledgment timeout after ${this.ackTimeout}ms`));
      }, this.ackTimeout);

      this.acks.set(ackId, {
        resolve,
        reject,
        timer,
        createdAt: Date.now(),
        retries: 0
      });

      this.metrics.sent++;
    });
  }

  /**
   * Resolve acknowledgment (called when server/client responds)
   */
  resolveAck(ackId, data) {
    const ack = this.acks.get(ackId);
    
    if (!ack) {
      console.warn(`[Acknowledgment] Unknown ack ID: ${ackId}`);
      return false;
    }

    clearTimeout(ack.timer);
    this.acks.delete(ackId);
    ack.resolve(data);
    this.metrics.received++;
    return true;
  }

  /**
   * Reject acknowledgment (called on error)
   */
  rejectAck(ackId, error) {
    const ack = this.acks.get(ackId);
    
    if (!ack) {
      console.warn(`[Acknowledgment] Unknown ack ID: ${ackId}`);
      return false;
    }

    clearTimeout(ack.timer);
    this.acks.delete(ackId);
    ack.reject(new Error(error || 'Acknowledgment rejected'));
    this.metrics.failed++;
    return true;
  }

  /**
   * Get pending acknowledgments
   */
  getPending() {
    return {
      count: this.acks.size,
      ackIds: Array.from(this.acks.keys())
    };
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      pending: this.acks.size,
      successRate: this.metrics.sent > 0
        ? ((this.metrics.received / this.metrics.sent) * 100).toFixed(2) + '%'
        : '0%'
    };
  }

  /**
   * Clear all pending acknowledgments
   */
  clear() {
    for (const [, ack] of this.acks.entries()) {
      clearTimeout(ack.timer);
      ack.reject(new Error('Acknowledgment manager cleared'));
    }
    this.acks.clear();
  }

  /**
   * Check for stale acknowledgments and cleanup
   */
  cleanup() {
    const now = Date.now();
    const stale = [];

    for (const [ackId, ack] of this.acks.entries()) {
      if (now - ack.createdAt > this.ackTimeout * 2) {
        stale.push(ackId);
      }
    }

    for (const ackId of stale) {
      this.rejectAck(ackId, 'Stale acknowledgment cleaned up');
    }

    return stale.length;
  }
}

/**
 * Wrapper for sending messages with acknowledgment
 */
export class AcknowledgmentWrapper {
  constructor(ackManager, socket) {
    this.ackManager = ackManager;
    this.socket = socket;
    this.pendingRetries = new Map();
  }

  /**
   * Send message with acknowledgment
   */
  async sendWithAck(event, data, options = {}) {
    const {
      timeout = this.ackManager.ackTimeout,
      retries = this.ackManager.retryAttempts
    } = options;

    const ackId = ++this.ackManager.ackCounter;
    
    // Create acknowledgment promise
    const ackPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackManager.acks.delete(ackId);
        this.ackManager.metrics.timeout++;
        reject(new Error(`Ack timeout for ${event}`));
      }, timeout);

      this.ackManager.acks.set(ackId, {
        resolve,
        reject,
        timer,
        createdAt: Date.now(),
        retries: 0
      });
    });

    // Send message with ack ID embedded
    const messageWithAck = {
      ...data,
      _ackId: ackId
    };

    try {
      this.socket.emit(event, messageWithAck);
      this.ackManager.metrics.sent++;
      return ackPromise;
    } catch (err) {
      this.ackManager.rejectAck(ackId, err.message);
      throw err;
    }
  }

  /**
   * Retry sending with acknowledgment
   */
  async sendWithAckAndRetry(event, data, options = {}) {
    const {
      timeout = this.ackManager.ackTimeout,
      maxRetries = this.ackManager.retryAttempts,
      retryDelay = this.ackManager.retryDelay
    } = options;

    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          // Wait before retrying
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }

        return await this.sendWithAck(event, data, { timeout });
      } catch (err) {
        lastError = err;
        console.log(`[Ack] Retry ${attempt + 1}/${maxRetries + 1} for ${event}: ${err.message}`);
      }
    }

    throw lastError;
  }
}

/**
 * Helper function to handle acknowledgment in handlers
 */
export function createAckHandler(callback) {
  return (data, ack) => {
    try {
      const result = callback(data);
      if (result instanceof Promise) {
        result
          .then(res => ack(res))
          .catch(err => ack({ error: err.message }));
      } else {
        ack(result);
      }
    } catch (err) {
      ack({ error: err.message });
    }
  };
}

export default AcknowledgmentManager;
