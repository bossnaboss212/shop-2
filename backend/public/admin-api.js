// admin-api.js - Client API pour se connecter au backend
// À inclure AVANT le script principal dans admin.html

const API = {
  config: {
    baseURL: window.location.origin,
    socket: null,
    isConnected: false
  },

  initSocket() {
    this.config.socket = io(this.config.baseURL, {
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5
    });

    this.config.socket.on('connect', () => {
      console.log('✅ WebSocket connecté');
      this.config.isConnected = true;
      this.updateConnectionStatus(true);
      
      const savedAuth = localStorage.getItem('admin_auth');
      if (savedAuth === 'true') {
        this.config.socket.emit('admin-auth', 'gangstaforlife12');
      }
    });

    this.config.socket.on('disconnect', () => {
      console.log('❌ WebSocket déconnecté');
      this.config.isConnected = false;
      this.updateConnectionStatus(false);
    });

    this.config.socket.on('auth-success', () => {
      console.log('✅ Admin authentifié');
    });

    // Événements temps réel
    this.config.socket.on('new-order', (order) => {
      console.log('🎉 Nouvelle commande:', order);
      if (typeof App !== 'undefined' && App.handleNewOrder) {
        App.handleNewOrder(order);
      }
    });

    this.config.socket.on('order-updated', (order) => {
      if (typeof App !== 'undefined' && App.handleOrderUpdate) {
        App.handleOrderUpdate(order);
      }
    });

    this.config.socket.on('product-updated', (product) => {
      if (typeof App !== 'undefined' && App.handleProductUpdate) {
        App.handleProductUpdate(product);
      }
    });

    this.config.socket.on('stock-updated', (product) => {
      if (typeof App !== 'undefined' && App.handleStockUpdate) {
        App.handleStockUpdate(product);
      }
    });

    this.config.socket.on('low-stock-alert', (data) => {
      if (typeof App !== 'undefined' && App.showNotification) {
        App.showNotification(
          `⚠️ Stock bas: ${data.product} ${data.variant} (${data.stock} restants)`,
          'warning'
        );
      }
    });

    this.config.socket.on('new-transaction', (transaction) => {
      if (typeof App !== 'undefined' && App.handleNewTransaction) {
        App.handleNewTransaction(transaction);
      }
    });
  },

  updateConnectionStatus(isConnected) {
    const statusEl = document.getElementById('syncStatus');
    if (statusEl) {
      if (isConnected) {
        statusEl.textContent = '🟢 Connecté';
        statusEl.style.color = 'var(--success)';
      } else {
        statusEl.textContent = '🔴 Déconnecté';
        statusEl.style.color = 'var(--danger)';
      }
    }
  },

  async request(endpoint, options = {}) {
    const url = `${this.config.baseURL}${endpoint}`;
    
    try {
      const response = await fetch(url, {
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        },
        ...options
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || 'Erreur API');
      }

      return await response.json();
    } catch (error) {
      console.error('Erreur API:', error);
      throw error;
    }
  },

  // ORDERS
  async getOrders(filters = {}) {
    const params = new URLSearchParams(filters).toString();
    return await this.request(`/api/orders?${params}`);
  },

  async createOrder(orderData) {
    return await this.request('/api/orders', {
      method: 'POST',
      body: JSON.stringify(orderData)
    });
  },

  async updateOrder(id, updates) {
    return await this.request(`/api/orders/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  },

  async deleteOrder(id) {
    return await this.request(`/api/orders/${id}`, {
      method: 'DELETE'
    });
  },

  // PRODUCTS
  async getProducts(filters = {}) {
    const params = new URLSearchParams(filters).toString();
    return await this.request(`/api/products?${params}`);
  },

  async createProduct(productData) {
    return await this.request('/api/products', {
      method: 'POST',
      body: JSON.stringify(productData)
    });
  },

  async updateProduct(id, updates) {
    return await this.request(`/api/products/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    });
  },

  async updateStock(id, stockData) {
    return await this.request(`/api/products/${id}/stock`, {
      method: 'PUT',
      body: JSON.stringify(stockData)
    });
  },

  async deleteProduct(id) {
    return await this.request(`/api/products/${id}`, {
      method: 'DELETE'
    });
  },

  // CASH/TRANSACTIONS
  async getCash() {
    return await this.request('/api/cash');
  },

  async getTodayCash() {
    return await this.request('/api/cash/today');
  },

  async createTransaction(transactionData) {
    return await this.request('/api/cash/transaction', {
      method: 'POST',
      body: JSON.stringify(transactionData)
    });
  },

  // STATS
  async getStats() {
    return await this.request('/api/stats');
  },

  async getSalesAnalytics(days = 7) {
    return await this.request(`/api/analytics/sales?days=${days}`);
  },

  // AUTH
  async login(password) {
    return await this.request('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password })
    });
  },

  async checkHealth() {
    try {
      const health = await this.request('/health');
      console.log('Server health:', health);
      return health;
    } catch (error) {
      console.error('Server unreachable');
      return null;
    }
  }
};

// Initialiser au chargement
if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => {
    API.initSocket();
    API.checkHealth().then(health => {
      if (health) {
        console.log('✅ Backend disponible');
      } else {
        console.warn('⚠️ Backend non disponible');
      }
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = API;
}
