class Logger {
  constructor(context = 'App') {
    this.context = context;
  }
  
  _formatMessage(level, message, meta = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toUpperCase(),
      context: this.context,
      message,
      ...meta
    };
    
    if (process.env.NODE_ENV === 'production') {
      return JSON.stringify(entry);
    } else {
      const emoji = {
        INFO: 'ℹ️',
        ERROR: '❌',
        WARN: '⚠️',
        DEBUG: '🔍',
        SUCCESS: '✅'
      }[level] || '📝';
      
      const metaStr = Object.keys(meta).length > 0 
        ? '\n' + JSON.stringify(meta, null, 2) 
        : '';
      
      return `${emoji} [${entry.timestamp}] ${level} [${this.context}] ${message}${metaStr}`;
    }
  }
  
  info(message, meta = {}) {
    console.log(this._formatMessage('INFO', message, meta));
  }
  
  error(message, meta = {}) {
    console.error(this._formatMessage('ERROR', message, meta));
  }
  
  warn(message, meta = {}) {
    console.warn(this._formatMessage('WARN', message, meta));
  }
  
  debug(message, meta = {}) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(this._formatMessage('DEBUG', message, meta));
    }
  }
  
  success(message, meta = {}) {
    console.log(this._formatMessage('SUCCESS', message, meta));
  }
}

module.exports = { Logger };
