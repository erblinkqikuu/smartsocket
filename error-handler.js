/**
 * SmartSocket Error Handler & Advanced API
 * 
 * Features:
 * - Comprehensive error handling and propagation
 * - Target, scatter, cast patterns
 * - Pulse (keep-alive), sync (state sync), query (request/response)
 * 
 * Disable: Create server with { enableErrorHandling: false }
 */

export class ErrorHandler {
  constructor(server) {
    this.server = server;
    this.errorHandlers = new Map();
    this.globalErrorHandlers = [];
    this.metrics = {
      total: 0,
      handled: 0,
      unhandled: 0
    };
  }

  /**
   * Register error handler for specific event
   */
  on(event, handler) {
    if (!this.errorHandlers.has(event)) {
      this.errorHandlers.set(event, []);
    }
    this.errorHandlers.get(event).push(handler);
    return this;
  }

  /**
   * Register global error handler (all errors)
   */
  onError(handler) {
    this.globalErrorHandlers.push(handler);
    return this;
  }

  /**
   * Emit error
   */
  emitError(socket, error, context = {}) {
    this.metrics.total++;

    const errorObj = {
      message: error.message || String(error),
      code: error.code || 'UNKNOWN_ERROR',
      timestamp: Date.now(),
      socketId: socket ? socket.id : null,
      ...context
    };

    // Try event-specific handlers first
    if (context.event && this.errorHandlers.has(context.event)) {
      const handlers = this.errorHandlers.get(context.event);
      for (const handler of handlers) {
        try {
          handler(socket, errorObj);
          this.metrics.handled++;
          return;
        } catch (err) {
          console.error('[ErrorHandler] Error in error handler:', err.message);
        }
      }
    }

    // Try global handlers
    for (const handler of this.globalErrorHandlers) {
      try {
        handler(socket, errorObj);
        this.metrics.handled++;
        return;
      } catch (err) {
        console.error('[ErrorHandler] Error in global handler:', err.message);
      }
    }

    // If no handler handled it
    this.metrics.unhandled++;
    console.error('[ErrorHandler] Unhandled error:', errorObj);

    // Send error to client
    if (socket && socket.emit) {
      socket.emit('error', {
        message: errorObj.message,
        code: errorObj.code
      });
    }
  }

  /**
   * Get error metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      handledRate: this.metrics.total > 0
        ? ((this.metrics.handled / this.metrics.total) * 100).toFixed(2) + '%'
        : '0%'
    };
  }
}

export class SmartSocketAPI {
  constructor(server) {
    this.server = server;
  }

  /**
   * Target: Send to specific socket
   * Usage: api.target(socketId, 'event', data)
   */
  target(socketId, event, data) {
    let found = false;
    this.server.sockets.forEach(socket => {
      if (socket.id === socketId) {
        socket.emit(event, data);
        found = true;
      }
    });
    return found;
  }

  /**
   * Scatter: Send to multiple sockets
   * Usage: api.scatter(socketIds, 'event', data)
   */
  scatter(socketIds, event, data) {
    const sent = [];
    this.server.sockets.forEach(socket => {
      if (socketIds.includes(socket.id)) {
        socket.emit(event, data);
        sent.push(socket.id);
      }
    });
    return sent;
  }

  /**
   * Cast: Broadcast to all (like emit)
   * Usage: api.cast('event', data)
   */
  cast(event, data) {
    let count = 0;
    this.server.sockets.forEach(socket => {
      socket.emit(event, data);
      count++;
    });
    return count;
  }

  /**
   * Pulse: Keep-alive/heartbeat
   * Usage: api.pulse('heartbeat', data, interval)
   */
  pulse(event, data, interval = 30000) {
    const pulseId = `pulse_${Date.now()}_${Math.random()}`;
    
    const pulseInterval = setInterval(() => {
      this.cast(event, { ...data, pulseId, timestamp: Date.now() });
    }, interval);

    return {
      pulseId,
      stop: () => clearInterval(pulseInterval)
    };
  }

  /**
   * Sync: Synchronize state across all clients
   * Usage: api.sync('state', sharedObject)
   */
  sync(namespace, state) {
    const syncId = `sync_${Date.now()}`;
    
    // Send initial state to all
    this.cast('__sync__', {
      syncId,
      namespace,
      state,
      timestamp: Date.now()
    });

    return {
      syncId,
      namespace,
      update: (newState) => {
        this.cast('__sync__', {
          syncId,
          namespace,
          state: newState,
          timestamp: Date.now(),
          action: 'update'
        });
      }
    };
  }

  /**
   * Query: Request/response pattern with timeout
   * Usage: const result = await api.query(socketId, 'get-data', timeout);
   */
  async query(socketId, event, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const queryId = `query_${Date.now()}_${Math.random()}`;
      let responded = false;

      const timer = setTimeout(() => {
        if (!responded) {
          responded = true;
          reject(new Error(`Query timeout for ${event}`));
        }
      }, timeout);

      // Register one-time response listener
      const responseEvent = `__response_${queryId}__`;
      let found = false;

      this.server.sockets.forEach(socket => {
        if (socket.id === socketId) {
          found = true;
          
          // Temporarily add listener
          const originalHandler = socket.handlers[responseEvent];
          socket.handlers[responseEvent] = (data) => {
            if (!responded) {
              responded = true;
              clearTimeout(timer);
              resolve(data);
            }
            // Restore original handler
            if (originalHandler) {
              socket.handlers[responseEvent] = originalHandler;
            } else {
              delete socket.handlers[responseEvent];
            }
          };

          // Send query
          socket.emit(event, {
            _queryId: queryId,
            _responseEvent: responseEvent
          });
        }
      });

      if (!found) {
        clearTimeout(timer);
        reject(new Error(`Socket not found: ${socketId}`));
      }
    });
  }

  /**
   * Rpc: Remote procedure call with automatic response handling
   * Usage: const result = await api.rpc(socketId, 'functionName', args);
   */
  async rpc(socketId, functionName, args = {}, timeout = 5000) {
    const rpcId = `rpc_${Date.now()}_${Math.random()}`;
    
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`RPC timeout for ${functionName}`));
      }, timeout);

      let found = false;
      this.server.sockets.forEach(socket => {
        if (socket.id === socketId) {
          found = true;
          
          const responseHandler = (result) => {
            clearTimeout(timer);
            delete socket.handlers[`__rpc_response_${rpcId}__`];
            resolve(result);
          };

          socket.handlers[`__rpc_response_${rpcId}__`] = responseHandler;
          
          socket.emit('__rpc__', {
            rpcId,
            functionName,
            args
          });
        }
      });

      if (!found) {
        clearTimeout(timer);
        reject(new Error(`Socket not found: ${socketId}`));
      }
    });
  }

  /**
   * Broadcast with filter
   * Usage: api.filter(socket => socket.data.role === 'admin', 'event', data)
   */
  filter(predicate, event, data) {
    let count = 0;
    this.server.sockets.forEach(socket => {
      if (predicate(socket)) {
        socket.emit(event, data);
        count++;
      }
    });
    return count;
  }

  /**
   * Group broadcast
   * Usage: api.group('admins', 'event', data)
   */
  group(groupName, event, data) {
    let count = 0;
    this.server.sockets.forEach(socket => {
      if (socket.data.groups && socket.data.groups.includes(groupName)) {
        socket.emit(event, data);
        count++;
      }
    });
    return count;
  }
}

export default ErrorHandler;
