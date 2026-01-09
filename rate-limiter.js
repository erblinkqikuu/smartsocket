/**
 * RateLimiter - Token bucket algorithm for fair resource distribution
 * Benefit: Prevent spam, protect against abuse, fair client distribution
 */

export class TokenBucket {
  constructor(capacity = 1000, refillRate = 100, interval = 1000) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.interval = interval;
    this.lastRefill = Date.now();
  }
  
  /**
   * Try to consume tokens
   * Returns true if allowed, false if rate limited
   */
  consume(tokens = 1) {
    this.refill();
    
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return false;
  }
  
  /**
   * Get current token count
   */
  getTokens() {
    this.refill();
    return this.tokens;
  }
  
  /**
   * Refill tokens based on time elapsed
   */
  refill() {
    const now = Date.now();
    const timePassed = (now - this.lastRefill) / 1000;
    
    // Calculate tokens to add
    const tokensToAdd = timePassed * (this.refillRate / 1000) * 1000;
    this.tokens = Math.min(this.capacity, this.tokens + tokensToAdd);
    
    this.lastRefill = now;
  }
  
  /**
   * Reset bucket to full
   */
  reset() {
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
}

/**
 * RateLimiter - Per-client rate limiting
 */
export class RateLimiter {
  constructor(options = {}) {
    this.clients = new Map();
    this.maxCapacity = options.maxCapacity || 1000;
    this.refillRate = options.refillRate || 100;
    this.cleanupInterval = options.cleanupInterval || 60000;
    
    this.stats = {
      totalRequests: 0,
      limitedRequests: 0,
      activeClients: 0
    };
    
    // Cleanup stale clients every minute
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupInterval);
  }
  
  /**
   * Check if client is allowed to make request
   */
  isAllowed(clientId, tokens = 1) {
    let bucket = this.clients.get(clientId);
    
    if (!bucket) {
      bucket = new TokenBucket(this.maxCapacity, this.refillRate);
      this.clients.set(clientId, bucket);
    }
    
    this.stats.totalRequests++;
    this.stats.activeClients = this.clients.size;
    
    const allowed = bucket.consume(tokens);
    
    if (!allowed) {
      this.stats.limitedRequests++;
      console.warn(`[RateLimiter] Client ${clientId} rate limited`);
    }
    
    return allowed;
  }
  
  /**
   * Get rate limit status for client
   */
  getStatus(clientId) {
    const bucket = this.clients.get(clientId);
    if (!bucket) return null;
    
    return {
      clientId,
      tokens: bucket.tokens.toFixed(2),
      capacity: bucket.capacity,
      percentage: ((bucket.tokens / bucket.capacity) * 100).toFixed(2),
      canConsume: bucket.tokens >= 1
    };
  }
  
  /**
   * Reset specific client's rate limit
   */
  reset(clientId) {
    const bucket = this.clients.get(clientId);
    if (bucket) {
      bucket.reset();
    }
  }
  
  /**
   * Remove stale clients (no activity for 10+ minutes)
   */
  cleanup() {
    const staleTime = 10 * 60 * 1000;
    const now = Date.now();
    let removedCount = 0;
    
    for (const [clientId, bucket] of this.clients.entries()) {
      if (now - bucket.lastRefill > staleTime) {
        this.clients.delete(clientId);
        removedCount++;
      }
    }
    
    this.stats.activeClients = this.clients.size;
    
    if (removedCount > 0) {
      console.debug(`[RateLimiter] Cleaned up ${removedCount} stale clients`);
    }
  }
  
  /**
   * Get statistics
   */
  getStats() {
    const limitRate = this.stats.totalRequests > 0 
      ? ((this.stats.limitedRequests / this.stats.totalRequests) * 100).toFixed(4)
      : 0;
    
    return {
      totalRequests: this.stats.totalRequests,
      limitedRequests: this.stats.limitedRequests,
      limitRate: `${limitRate}%`,
      activeClients: this.stats.activeClients
    };
  }
  
  /**
   * Destroy and cleanup
   */
  destroy() {
    clearInterval(this.cleanupTimer);
    this.clients.clear();
  }
}

/**
 * Adaptive RateLimiter - Adjusts limits based on server load
 */
export class AdaptiveRateLimiter extends RateLimiter {
  constructor(options = {}) {
    super(options);
    this.baseRefillRate = options.refillRate || 100;
    this.cpuThreshold = options.cpuThreshold || 80;
    this.memoryThreshold = options.memoryThreshold || 85;
  }
  
  /**
   * Adjust rate limits based on server metrics
   */
  adjustForLoad(cpuUsage, memoryUsage) {
    let multiplier = 1.0;
    
    // Reduce limits if CPU is high
    if (cpuUsage > this.cpuThreshold) {
      multiplier *= 0.7; // Reduce to 70%
    }
    
    // Reduce limits if memory is high
    if (memoryUsage > this.memoryThreshold) {
      multiplier *= 0.8; // Reduce to 80%
    }
    
    // Update refill rate
    this.refillRate = this.baseRefillRate * multiplier;
    
    return multiplier;
  }
}
