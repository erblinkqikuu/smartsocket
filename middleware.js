/**
 * SmartSocket Middleware System - Production Grade
 * 
 * Usage:
 * const middleware = new MiddlewareManager();
 * middleware.useRequest((socket, event, data, next) => {
 *   console.log(`Incoming: ${event}`);
 *   next(); // Continue to next middleware or handler
 * });
 * 
 * Disable: Create server with { enableMiddleware: false }
 */

export class MiddlewareManager {
  constructor() {
    this.requestMiddleware = [];    // Incoming messages
    this.responseMiddleware = [];   // Outgoing messages
    this.errorMiddleware = [];      // Error handling
    this.globalMiddleware = [];     // Runs for all events
    this.metrics = {
      processed: 0,
      errors: 0,
      totalTime: 0,
      slowestTime: 0
    };
  }

  /**
   * Register request middleware (incoming messages)
   * Executes BEFORE message reaches handler
   */
  useRequest(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Middleware must be a function');
    }
    this.requestMiddleware.push(handler);
    return this;
  }

  /**
   * Register response middleware (outgoing messages)
   * Executes AFTER handler, BEFORE message is sent
   */
  useResponse(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Middleware must be a function');
    }
    this.responseMiddleware.push(handler);
    return this;
  }

  /**
   * Register error middleware
   * Handles errors from other middleware or handlers
   */
  useError(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Middleware must be a function');
    }
    this.errorMiddleware.push(handler);
    return this;
  }

  /**
   * Register global middleware (runs for every event)
   */
  use(handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('Middleware must be a function');
    }
    this.globalMiddleware.push(handler);
    return this;
  }

  /**
   * Execute request middleware chain
   */
  async executeRequest(socket, event, data, context = {}) {
    const startTime = Date.now();
    
    try {
      const allMiddleware = [...this.globalMiddleware, ...this.requestMiddleware];
      
      for (const middleware of allMiddleware) {
        let called = false;
        
        await new Promise((resolve, reject) => {
          const next = (err) => {
            if (called) return; // Prevent calling next() multiple times
            called = true;
            
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          };
          
          // Timeout protection: 5 seconds
          const timeout = setTimeout(() => {
            if (!called) {
              called = true;
              reject(new Error(`Middleware timeout for event: ${event}`));
            }
          }, 5000);
          
          try {
            middleware(socket, event, data, next, context);
          } catch (err) {
            clearTimeout(timeout);
            reject(err);
          }
        });
      }
      
      const duration = Date.now() - startTime;
      this.metrics.processed++;
      this.metrics.totalTime += duration;
      this.metrics.slowestTime = Math.max(this.metrics.slowestTime, duration);
      
      return { allowed: true, duration };
    } catch (err) {
      this.metrics.errors++;
      return { 
        allowed: false, 
        error: err.message,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Execute response middleware chain
   */
  async executeResponse(socket, event, data, context = {}) {
    const startTime = Date.now();
    
    try {
      const allMiddleware = [...this.globalMiddleware, ...this.responseMiddleware];
      
      for (const middleware of allMiddleware) {
        let called = false;
        
        await new Promise((resolve, reject) => {
          const next = (err) => {
            if (called) return;
            called = true;
            
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          };
          
          // Timeout protection: 5 seconds
          const timeout = setTimeout(() => {
            if (!called) {
              called = true;
              reject(new Error(`Middleware timeout for response: ${event}`));
            }
          }, 5000);
          
          try {
            middleware(socket, event, data, next, context);
          } catch (err) {
            clearTimeout(timeout);
            reject(err);
          }
        });
      }
      
      const duration = Date.now() - startTime;
      return { allowed: true, duration };
    } catch (err) {
      this.metrics.errors++;
      return { 
        allowed: false, 
        error: err.message,
        duration: Date.now() - startTime
      };
    }
  }

  /**
   * Execute error middleware
   */
  async executeError(socket, error, context = {}) {
    try {
      for (const middleware of this.errorMiddleware) {
        let called = false;
        
        await new Promise((resolve) => {
          const next = () => {
            if (called) return;
            called = true;
            resolve();
          };
          
          try {
            middleware(socket, error, next, context);
          } catch (err) {
            console.error('[Middleware] Error in error handler:', err.message);
            resolve();
          }
        });
      }
    } catch (err) {
      console.error('[Middleware] Failed to execute error middleware:', err.message);
    }
  }

  /**
   * Get middleware statistics
   */
  getMetrics() {
    return {
      ...this.metrics,
      averageTime: this.metrics.processed > 0 
        ? Math.round(this.metrics.totalTime / this.metrics.processed) 
        : 0,
      errorRate: this.metrics.processed > 0
        ? ((this.metrics.errors / this.metrics.processed) * 100).toFixed(2) + '%'
        : '0%'
    };
  }

  /**
   * Clear all middleware
   */
  clear() {
    this.requestMiddleware = [];
    this.responseMiddleware = [];
    this.errorMiddleware = [];
    this.globalMiddleware = [];
    this.metrics = {
      processed: 0,
      errors: 0,
      totalTime: 0,
      slowestTime: 0
    };
  }
}

/**
 * Built-in middleware templates
 */

export const BuiltinMiddleware = {
  /**
   * Authentication middleware
   * Checks for authentication token
   */
  auth: (requiredRoles = []) => {
    return (socket, event, data, next) => {
      if (!socket.data.authenticated) {
        return next(new Error('Not authenticated'));
      }
      
      if (requiredRoles.length > 0) {
        const userRole = socket.data.role || 'user';
        if (!requiredRoles.includes(userRole)) {
          return next(new Error('Insufficient permissions'));
        }
      }
      
      next();
    };
  },

  /**
   * Rate limiting middleware
   */
  rateLimit: (maxEvents, windowMs) => {
    const userLimits = new Map();
    
    return (socket, event, data, next) => {
      const userId = socket.id;
      const now = Date.now();
      
      if (!userLimits.has(userId)) {
        userLimits.set(userId, { count: 0, resetTime: now + windowMs });
      }
      
      const limit = userLimits.get(userId);
      
      if (now > limit.resetTime) {
        limit.count = 0;
        limit.resetTime = now + windowMs;
      }
      
      if (limit.count >= maxEvents) {
        return next(new Error('Rate limit exceeded'));
      }
      
      limit.count++;
      next();
    };
  },

  /**
   * Data validation middleware
   */
  validate: (schema) => {
    return (socket, event, data, next) => {
      try {
        // Simple validation: check if required fields exist
        if (!schema.required) {
          return next();
        }
        
        for (const field of schema.required) {
          if (!(field in data)) {
            return next(new Error(`Missing required field: ${field}`));
          }
        }
        
        next();
      } catch (err) {
        next(err);
      }
    };
  },

  /**
   * Logging middleware
   */
  logger: (level = 'info') => {
    return (socket, event, data, next) => {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [${level.toUpperCase()}] ${socket.id} - Event: ${event}`);
      next();
    };
  },

  /**
   * Data transformation middleware
   */
  transform: (transformFn) => {
    return (socket, event, data, next, context) => {
      try {
        const transformed = transformFn(data);
        context.transformedData = transformed;
        next();
      } catch (err) {
        next(err);
      }
    };
  }
};

export default MiddlewareManager;
