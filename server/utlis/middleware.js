// ============================================================
// MIDDLEWARE - Gestion d'erreurs et utilitaires
// ============================================================

const { Logger } = require('./logger');
const logger = new Logger('Middleware');

// Wrapper pour routes async
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Middleware de logging des requêtes
const requestLogger = (req, res, next) => {
  const start = Date.now();
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    const logData = {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip
    };
    
    if (res.statusCode >= 400) {
      logger.warn('Request failed', logData);
    } else {
      logger.info('Request completed', logData);
    }
  });
  
  next();
};

// Middleware de gestion d'erreurs global
const errorHandler = (err, req, res, next) => {
  logger.error('Request error', {
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    path: req.path,
    method: req.method,
    statusCode: err.statusCode || 500
  });
  
  const statusCode = err.statusCode || 500;
  
  let message = err.message;
  if (process.env.NODE_ENV === 'production' && statusCode === 500) {
    message = 'Une erreur interne est survenue';
  }
  
  res.status(statusCode).json({
    ok: false,
    error: message,
    field: err.field || undefined,
    timestamp: new Date().toISOString()
  });
};

// Middleware 404
const notFoundHandler = (req, res) => {
  res.status(404).json({
    ok: false,
    error: 'Route non trouvée',
    path: req.path
  });
};

// Middleware de validation du content-type
const validateContentType = (req, res, next) => {
  if (req.method === 'POST' || req.method === 'PUT') {
    const contentType = req.get('content-type');
    
    if (!contentType || !contentType.includes('application/json')) {
      return res.status(415).json({
        ok: false,
        error: 'Content-Type doit être application/json'
      });
    }
  }
  
  next();
};

// Rate limiter personnalisé
class RateLimiter {
  constructor() {
    this.attempts = new Map();
  }
  
  canProceed(key, maxAttempts = 5, timeWindow = 60000) {
    const now = Date.now();
    
    if (!this.attempts.has(key)) {
      this.attempts.set(key, []);
    }
    
    const attempts = this.attempts.get(key).filter(
      time => now - time < timeWindow
    );
    
    this.attempts.set(key, attempts);
    
    if (attempts.length >= maxAttempts) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(attempts[0] + timeWindow)
      };
    }
    
    attempts.push(now);
    this.attempts.set(key, attempts);
    
    return {
      allowed: true,
      remaining: maxAttempts - attempts.length,
      resetAt: new Date(now + timeWindow)
    };
  }
  
  reset(key) {
    this.attempts.delete(key);
  }
  
  cleanup() {
    const now = Date.now();
    for (const [key, attempts] of this.attempts.entries()) {
      if (attempts.length === 0 || now - attempts[attempts.length - 1] > 3600000) {
        this.attempts.delete(key);
      }
    }
  }
}

const rateLimiter = new RateLimiter();

setInterval(() => {
  rateLimiter.cleanup();
  logger.debug('Rate limiter cleanup completed');
}, 3600000);

module.exports = {
  asyncHandler,
  requestLogger,
  errorHandler,
  notFoundHandler,
  validateContentType,
  rateLimiter
};
```

✅ **Sauvegarde ce fichier**

---

## ✅ **Vérification rapide**

Tu devrais maintenant avoir :
```
server/
  ├── utils/
  │   ├── logger.js      ✅
  │   ├── validation.js  ✅
  │   └── middleware.js  ✅
  ├── index.js           (on va le modifier après)
  └── bot.js             (on touche pas)
