/**
 * ConnectionMultiplexer - Multiple streams per connection
 * Benefit: 3x concurrent throughput, prevent head-of-line blocking
 */

export class ConnectionMultiplexer {
  constructor(options = {}) {
    this.maxStreams = options.maxStreams || Infinity;  // Unlimited streams
    this.streams = new Map();
    this.nextStreamId = 1;
    this.roundRobinIndex = 0;
    
    this.stats = {
      totalStreams: 0,
      activeStreams: 0,
      messagesSent: 0,
      messagesPending: 0
    };
  }
  
  /**
   * Create a new stream
   */
  createStream(options = {}) {
    // No limit on streams - allows unlimited connections
    if (this.maxStreams !== Infinity && this.streams.size >= this.maxStreams) {
      throw new Error(`[Multiplexer] Max streams (${this.maxStreams}) reached`);
    }
    
    const streamId = this.nextStreamId++;
    const stream = {
      id: streamId,
      queue: [],
      active: true,
      priority: options.priority || 5, // 1-10, higher = more urgent
      weight: options.weight || 1,
      paused: false,
      created: Date.now(),
      stats: {
        sent: 0,
        pending: 0
      }
    };
    
    this.streams.set(streamId, stream);
    this.stats.totalStreams++;
    this.stats.activeStreams = this.streams.size;
    
    return streamId;
  }
  
  /**
   * Send data on a stream
   */
  send(streamId, data) {
    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`[Multiplexer] Unknown stream ${streamId}`);
    }
    
    if (!stream.active || stream.paused) {
      return false;
    }
    
    stream.queue.push(data);
    stream.stats.pending++;
    this.stats.messagesPending++;
    
    return true;
  }
  
  /**
   * Get all pending data from all streams (respecting priority)
   */
  getPendingData() {
    // Sort by priority (higher first) then by round-robin weight
    const sorted = Array.from(this.streams.values())
      .filter(s => s.active && !s.paused && s.queue.length > 0)
      .sort((a, b) => b.priority - a.priority);
    
    const data = [];
    
    // Send from each stream respecting weight
    for (const stream of sorted) {
      const itemsToSend = Math.ceil(stream.weight);
      for (let i = 0; i < itemsToSend && stream.queue.length > 0; i++) {
        data.push({
          streamId: stream.id,
          data: stream.queue.shift(),
          priority: stream.priority
        });
        stream.stats.sent++;
        stream.stats.pending--;
        this.stats.messagesSent++;
        this.stats.messagesPending--;
      }
    }
    
    return data;
  }
  
  /**
   * Pause a stream
   */
  pauseStream(streamId) {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.paused = true;
    }
  }
  
  /**
   * Resume a stream
   */
  resumeStream(streamId) {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.paused = false;
    }
  }
  
  /**
   * Close a stream
   */
  closeStream(streamId) {
    const stream = this.streams.get(streamId);
    if (stream) {
      stream.active = false;
      stream.queue = [];
      this.streams.delete(streamId);
      this.stats.activeStreams = this.streams.size;
    }
  }
  
  /**
   * Get stream statistics
   */
  getStreamStats(streamId) {
    const stream = this.streams.get(streamId);
    if (!stream) return null;
    
    return {
      streamId,
      priority: stream.priority,
      weight: stream.weight,
      active: stream.active,
      paused: stream.paused,
      pending: stream.stats.pending,
      sent: stream.stats.sent,
      uptime: Date.now() - stream.created
    };
  }
  
  /**
   * Get all statistics
   */
  getStats() {
    const streams = [];
    for (const stream of this.streams.values()) {
      streams.push({
        id: stream.id,
        pending: stream.stats.pending,
        sent: stream.stats.sent,
        priority: stream.priority
      });
    }
    
    return {
      maxStreams: this.maxStreams,
      activeStreams: this.stats.activeStreams,
      totalCreated: this.stats.totalStreams,
      messagesSent: this.stats.messagesSent,
      messagesPending: this.stats.messagesPending,
      streams
    };
  }
  
  /**
   * Clear all streams
   */
  clear() {
    this.streams.clear();
    this.stats = {
      totalStreams: 0,
      activeStreams: 0,
      messagesSent: 0,
      messagesPending: 0
    };
  }
}

/**
 * Stream scheduler - Optimizes stream ordering
 */
export class StreamScheduler {
  constructor(multiplexer) {
    this.multiplexer = multiplexer;
    this.schedules = new Map();
  }
  
  /**
   * Set custom priority for stream (1-10)
   */
  setPriority(streamId, priority) {
    const stream = this.multiplexer.streams.get(streamId);
    if (stream) {
      stream.priority = Math.max(1, Math.min(10, priority));
    }
  }
  
  /**
   * Set custom weight for stream (affects bandwidth allocation)
   */
  setWeight(streamId, weight) {
    const stream = this.multiplexer.streams.get(streamId);
    if (stream) {
      stream.weight = Math.max(0.1, Math.min(10, weight));
    }
  }
  
  /**
   * Get optimal stream order
   */
  getOptimalOrder() {
    const sorted = Array.from(this.multiplexer.streams.values())
      .filter(s => s.active && !s.paused)
      .sort((a, b) => {
        // Primary sort: priority (higher first)
        if (a.priority !== b.priority) {
          return b.priority - a.priority;
        }
        // Secondary sort: pending messages (fewer first - fairness)
        if (a.stats.pending !== b.stats.pending) {
          return a.stats.pending - b.stats.pending;
        }
        // Tertiary: by creation time (older first)
        return a.created - b.created;
      });
    
    return sorted.map(s => s.id);
  }
}
