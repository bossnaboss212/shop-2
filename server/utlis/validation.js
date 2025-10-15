// ============================================================
// VALIDATION - Fonctions de validation robustes
// ============================================================

class ValidationError extends Error {
  constructor(message, field = null) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    this.statusCode = 400;
  }
}

// Sanitization avancée
function sanitizeString(str, type = 'text', maxLength = 500) {
  if (typeof str !== 'string') return '';
  
  let sanitized = str.trim();
  sanitized = sanitized.slice(0, maxLength);
  
  switch(type) {
    case 'phone':
      sanitized = sanitized.replace(/[^\d+]/g, '');
      if (sanitized.length > 15) sanitized = sanitized.slice(0, 15);
      break;
      
    case 'address':
      sanitized = sanitized.replace(/[^a-zA-Z0-9À-ÿ\s,.\-']/g, '');
      break;
      
    case 'contact':
      sanitized = sanitized.replace(/[^a-zA-Z0-9_@]/g, '');
      break;
      
    case 'text':
    default:
      sanitized = sanitized
        .replace(/[<>]/g, '')
        .replace(/javascript:/gi, '')
        .replace(/on\w+=/gi, '')
        .replace(/data:text\/html/gi, '');
  }
  
  return sanitized;
}

// Validation d'adresse
function validateAddress(address) {
  if (!address || typeof address !== 'string') {
    return { valid: false, error: 'Adresse requise' };
  }
  
  const cleaned = address.trim();
  
  if (cleaned.length < 5) {
    return { valid: false, error: 'Adresse trop courte (minimum 5 caractères)' };
  }
  
  if (cleaned.length > 200) {
    return { valid: false, error: 'Adresse trop longue (maximum 200 caractères)' };
  }
  
  const hasNumber = /\d/.test(cleaned);
  if (!hasNumber) {
    return { valid: false, error: 'L\'adresse doit contenir un numéro de rue' };
  }
  
  const streetTypes = /rue|avenue|boulevard|place|allée|impasse|chemin|route|voie|cours|quai|square|bd|av/i;
  const hasStreet = streetTypes.test(cleaned);
  
  if (!hasStreet) {
    return { 
      valid: false, 
      error: 'Format d\'adresse invalide. Exemple: 12 Rue de la Paix, Millau' 
    };
  }
  
  return { valid: true };
}

// Validation de commande
function validateOrderInput(data) {
  const { customer, type, items, total, address } = data;
  
  if (!customer || typeof customer !== 'string') {
    throw new ValidationError('Contact client invalide', 'customer');
  }
  
  const cleanCustomer = customer.trim();
  if (cleanCustomer.length < 2 || cleanCustomer.length > 100) {
    throw new ValidationError('Contact client doit faire entre 2 et 100 caractères', 'customer');
  }
  
  if (!type || typeof type !== 'string') {
    throw new ValidationError('Type de livraison invalide', 'type');
  }
  
  if (address) {
    const addressValidation = validateAddress(address);
    if (!addressValidation.valid) {
      throw new ValidationError(addressValidation.error, 'address');
    }
  }
  
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('Panier vide', 'items');
  }
  
  if (items.length > 50) {
    throw new ValidationError('Trop d\'articles dans le panier (max 50)', 'items');
  }
  
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    
    if (!item.product_id || typeof item.product_id !== 'number') {
      throw new ValidationError(`Article ${i + 1}: ID produit invalide`, 'items');
    }
    
    if (!item.name || typeof item.name !== 'string' || item.name.trim().length < 2) {
      throw new ValidationError(`Article ${i + 1}: Nom invalide`, 'items');
    }
    
    if (!item.variant || typeof item.variant !== 'string') {
      throw new ValidationError(`Article ${i + 1}: Variante invalide`, 'items');
    }
    
    if (!item.qty || typeof item.qty !== 'number' || item.qty < 1 || item.qty > 999) {
      throw new ValidationError(`Article ${i + 1}: Quantité invalide (1-999)`, 'items');
    }
    
    if (typeof item.price !== 'number' || item.price < 0) {
      throw new ValidationError(`Article ${i + 1}: Prix invalide`, 'items');
    }
    
    if (typeof item.lineTotal !== 'number' || item.lineTotal < 0) {
      throw new ValidationError(`Article ${i + 1}: Total ligne invalide`, 'items');
    }
    
    const expectedTotal = item.price * item.qty;
    if (Math.abs(item.lineTotal - expectedTotal) > 0.01) {
      throw new ValidationError(`Article ${i + 1}: Calcul du total incorrect`, 'items');
    }
  }
  
  if (typeof total !== 'number' || total < 0) {
    throw new ValidationError('Montant total invalide', 'total');
  }
  
  if (total > 100000) {
    throw new ValidationError('Montant total trop élevé', 'total');
  }
  
  const calculatedTotal = items.reduce((sum, item) => sum + item.lineTotal, 0);
  if (Math.abs(total - calculatedTotal) > 0.01) {
    throw new ValidationError('Le total ne correspond pas à la somme des articles', 'total');
  }
  
  return true;
}

// Validation de transaction
function validateTransaction(data) {
  const { type, category, description, amount, date } = data;
  
  if (!['revenue', 'expense'].includes(type)) {
    throw new ValidationError('Type de transaction invalide (revenue ou expense)', 'type');
  }
  
  if (!category || typeof category !== 'string' || category.trim().length < 2) {
    throw new ValidationError('Catégorie requise', 'category');
  }
  
  if (!description || typeof description !== 'string' || description.trim().length < 2) {
    throw new ValidationError('Description requise', 'description');
  }
  
  if (typeof amount !== 'number' || amount < 0) {
    throw new ValidationError('Montant invalide', 'amount');
  }
  
  if (amount > 1000000) {
    throw new ValidationError('Montant trop élevé', 'amount');
  }
  
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ValidationError('Format de date invalide (YYYY-MM-DD)', 'date');
  }
  
  return true;
}

// Validation de mouvement de stock
function validateStockMovement(data) {
  const { product_id, variant, type, quantity } = data;
  
  if (typeof product_id !== 'number' || product_id < 1) {
    throw new ValidationError('ID produit invalide', 'product_id');
  }
  
  if (!variant || typeof variant !== 'string' || variant.trim().length < 1) {
    throw new ValidationError('Variante requise', 'variant');
  }
  
  if (!['in', 'out'].includes(type)) {
    throw new ValidationError('Type invalide (in ou out)', 'type');
  }
  
  if (typeof quantity !== 'number' || quantity < 0 || quantity > 10000) {
    throw new ValidationError('Quantité invalide (0-10000)', 'quantity');
  }
  
  return true;
}

module.exports = {
  ValidationError,
  sanitizeString,
  validateAddress,
  validateOrderInput,
  validateTransaction,
  validateStockMovement
};
