// FRONT
const API = "/api"; // Sur Netlify: remplace par l'URL complète de ton backend Railway (ex: https://XXX.up.railway.app/api)
const fmt = n => new Intl.NumberFormat('fr-FR',{style:'currency',currency:'EUR'}).format(n);

// 11 produits (noms neutres) – remplace librement name/farm/category pic/video
const PRODUCTS = [
  { id:1,  name:"AMNESIA",  farm:"coffee shop", category:"weed",    pic:"img/amnesia.JPG",      video:"video/amnesia.MP4",
    variants:[{label:"3,33G",grams:3.33,price:20},{label:"5G",grams:5,price:30},{label:"10G",grams:10,price:60},{label:"50G",grams:50,price:250},{label:"100G",grams:100,price:450}] },
  { id:2,  name:"NEEDLES KETA",  farm:"holland",   category:"kéta",    pic:"img/needles.JPG",      video:"video/needles.MP4",
    variants:[{label:"1G",grams:1,price:20},{label:"2G",grams:2,price:40},{label:"3G",grams:3,price:50},{label:"5G",grams:5,price:80},{label:"10G",grams:10,price:150}] },
  { id:3,  name:"CHAMPAGNE",  farm:"hollande",   category:"🌈 mdma",                               video:"video/champagne.MP4",
    variants:[{label:"1G",grams:1,price:20},{label:"2G",grams:2,price:40},{label:"3G",grams:3,price:50},{label:"5G",grams:5,price:80},{label:"10G",grams:10,price:150}] },
  { id:4,  name:"el jefe",  farm:"colombie",    category:"❄️ blanche neige",                     video:"video/el_jefe.MP4",
    variants:[{label:"0,5G",grams:0.5,price:30},{label:"1G",grams:1,price:50},{label:"2G",grams:2,price:100},{label:"5G",grams:5,price:250},{label:"10G",grams:10,price:430}] },
  { id:5,  name:"SKITTLEZ CAKE 120u",  farm:"hash montaine", category:"🤯 filtré", pic:"img/skittlez_cake.JPG", video:"video/skittlez_cake.MP4",
    variants:[{label:"2,5G",grams:2.5,price:20},{label:"5G",grams:5,price:40},{label:"10G",grams:10,price:70},{label:"50G",grams:50,price:290}] },
  { id:6,  name:"PISTACCHIO 73u",  farm:"hash montaine", category:"🤯 filtré", pic:"img/pistacchio.JPG",   video:"video/pistacchio.MP4",
    variants:[{label:"3G",grams:3,price:20},{label:"5G",grams:5,price:50},{label:"10G",grams:10,price:90},{label:"50G",grams:50,price:250}] },
  { id:7,  name:"DEMBELE",  farm:"morroco",     category:"🧽super mousseux",                          video:"video/dembele.MP4",
    variants:[{label:"3,5G",grams:3.5,price:20},{label:"5G",grams:5,price:30},{label:"10G",grams:10,price:50},{label:"50G",grams:50,price:190},{label:"100G",grams:100,price:370}] },
  { id:8,  name:"LEMON X GELATO",  farm:"top shelf",   category:"🇺🇸 cali us",                           video:"video/lemonxgelato.MP4",
    variants:[{label:"1,66G",grams:1.66,price:20},{label:"3,5G",grams:3.5,price:40},{label:"5G",grams:5,price:60},{label:"10G",grams:10,price:110}] },
  { id:9,  name:"GEORGIA PIE",  farm:"top shelf",   category:"🇺🇸 cali us",                           video:"video/georgia_pie.MP4",
    variants:[{label:"1,66G",grams:1.66,price:20},{label:"3,5G",grams:3.5,price:40},{label:"5G",grams:5,price:60},{label:"10G",grams:10,price:110}] },
  { id:10, name:"DOMINO 280mg", farm:"Selection",   category:"💊 bonbon",                             video:"video/domino.MP4",
    variants:[{label:"3 unités",grams:0,price:20},{label:"10 unités",grams:0,price:60},{label:"50 unités",grams:0,price:150}] },
  { id:11, name:"FRESHH FROZEN", farm:"FRESH",       category:"🤯 filtré",                             video:"video/fresh_frozen.MP4",
    variants:[{label:"1,1G",grams:1.1,price:20},{label:"2,3G",grams:2.3,price:40},{label:"3,5G",grams:3.5,price:50},{label:"5G",grams:5,price:80},{label:"10G",grams:10,price:160}] }
];


// ---- UI de base ----
const pages = ['home','infos','avis','support'];
document.querySelectorAll('.bottom .tab').forEach(b=>{
  b.onclick = ()=>{
    document.querySelectorAll('.bottom .tab').forEach(x=>x.classList.remove('active'));
    b.classList.add('active');
    const p = b.dataset.tab;
    document.querySelectorAll('.page').forEach(pg=>pg.classList.remove('active'));
    document.getElementById('page-'+p).classList.add('active');
  };
});

// Filtres par catégorie
const filtersBox = document.getElementById('filters');
const CATS = Array.from(new Set(PRODUCTS.map(p=>p.category)));
function renderFilters(){
  filtersBox.innerHTML = `<span class="chip" data-cat="__all">Tout</span>` + 
    CATS.map(c=>`<span class="chip" data-cat="${c}">${c}</span>`).join('');
  filtersBox.querySelectorAll('.chip').forEach(ch=>{
    ch.onclick = ()=> renderGrid(ch.dataset.cat);
  });
}
renderFilters();

const grid = document.getElementById('grid');
function media(p){
  if(p.video) return `<video class="thumb" src="${p.video}" playsinline autoplay muted loop></video>`;
  if(p.pic) return `<img class="thumb" src="${p.pic}" />`;
  return `<img class="thumb" src="https://picsum.photos/seed/${p.id}/600/600" />`;
}
function renderGrid(cat="__all"){
  grid.innerHTML='';
  const list = (cat==="__all") ? PRODUCTS : PRODUCTS.filter(p=>p.category===cat);
  for(const p of list){
    const div = document.createElement('div'); div.className='card';
    div.innerHTML = `${media(p)}<div class="meta"><div class="muted">${p.farm||''}</div><b>${p.name}</b><div style="margin-top:8px"><button class="primary" data-id="${p.id}">Voir</button></div></div>`;
    grid.appendChild(div);
  }
  grid.querySelectorAll('button[data-id]').forEach(b=> b.onclick = ()=> openProduct(Number(b.dataset.id)));
}
renderGrid();

// ---- Fiche produit + panier ----
const badge = document.getElementById('badge'); let CART = {};

function openProduct(id){
  const p = PRODUCTS.find(x=>x.id===id);
  const variants = p.variants||[];
  const html = `
    <div style="padding:8px">
      ${media(p)}
      <h3 style="margin:8px 0">${p.name}</h3>
      <div class="muted">${p.farm||''}</div>
      <div style="margin-top:10px">
        ${variants.map(v=>`<div style="display:flex;justify-content:space-between;align-items:center;padding:8px;border:1px solid #222;border-radius:10px;margin-top:6px">
          <div>
            <div class="muted">${v.label} ${v.grams?('- '+v.grams+' g'):''}</div>
            <div><b>${fmt(v.price)}</b></div>
          </div>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="number" min="1" value="1" style="width:64px;padding:6px;border-radius:8px;background:#0b0f16;border:1px solid #232a33;color:#e8edf2">
            <button class="primary add" data-price="${v.price}" data-label="${v.label}">Ajouter</button>
          </div>
        </div>`).join('')}
      </div>
    </div>`;
  const sheet = document.createElement('div');
  sheet.className='sheet';
  sheet.innerHTML = `<div class="sheet-card">${html}<div style="margin-top:10px"><button id="closeSheet" class="primary">Fermer</button></div></div>`;
  document.body.appendChild(sheet);
  document.getElementById('closeSheet').onclick = ()=> sheet.remove();
  sheet.querySelectorAll('.add').forEach(b=> b.onclick = (e)=>{
    const qty = Number(e.target.previousElementSibling.value||1);
    addToCart(p, e.target.dataset.label, Number(e.target.dataset.price), qty); sheet.remove();
  });
}

function addToCart(p,label,price,qty){
  const key = `${p.id}__${label}`;
  CART[key] = CART[key] || { product_id:p.id, name:p.name, variant:label, price:price, qty:0, img:p.pic||p.video||'' };
  CART[key].qty += qty;
  updateBadge();
}
function updateBadge(){ badge.textContent = Object.values(CART).reduce((s,l)=>s+l.qty,0); }
document.getElementById('cartBtn').onclick = openCart;

function openCart(){
  const elLines = document.getElementById('lines'); elLines.innerHTML='';
  let total=0;
  for(const [k,l] of Object.entries(CART)){
    const sub = l.price * l.qty; total += sub;
    const mediaHtml = l.img?.endsWith('.MP4') ? `<video src="${l.img}" playsinline muted loop></video>` : `<img src="${l.img||('https://picsum.photos/seed/'+k+'/80/80')}" />`;
    const row = document.createElement('div'); row.className='line';
    row.innerHTML = `${mediaHtml}<div style="flex:1"><b>${l.name}</b><div class="muted">${l.variant} • ${fmt(l.price)} × ${l.qty}</div></div><div>${fmt(sub)}</div>`;
    elLines.appendChild(row);
  }
  document.getElementById('total').textContent = fmt(total);
  document.getElementById('cartSheet').classList.remove('hidden');
}
document.getElementById('closeCart').onclick = ()=> document.getElementById('cartSheet').classList.add('hidden');

// ---- Autocomplete adresse (Mapbox via backend proxy) ----
let timer=null; const addr = document.getElementById('addr');
addr?.addEventListener('input', ()=>{
  clearTimeout(timer);
  timer = setTimeout(async ()=>{
    const q = addr.value.trim(); 
    if(!q || q.length<2){ document.getElementById('suggestions').innerHTML=''; return; }
    const r = await fetch(`${API}/geocode?q=${encodeURIComponent(q)}`);
    const j = await r.json();
    document.getElementById('suggestions').innerHTML = (j.features||[]).map(f=>`<div data-v="${encodeURIComponent(f.place_name)}">${f.place_name}</div>`).join('');
    document.querySelectorAll('#suggestions div').forEach(d=> d.onclick = ()=>{
      addr.value = decodeURIComponent(d.dataset.v);
      document.getElementById('suggestions').innerHTML='';
    });
  }, 250);
});

// ---- Checkout ----
document.getElementById('checkout').onclick = async ()=>{
  const items = []; let total = 0;
  for(const l of Object.values(CART)){
    const lineTotal = l.qty * l.price; total += lineTotal;
    items.push({ product_id:l.product_id, name:l.name, variant:l.variant, qty:l.qty, price:l.price, lineTotal });
  }
  const delivery = Array.from(document.querySelectorAll('input[name="delivery"]')).find(x=>x.checked)?.value || 'Livraison sur Millau';
  if (delivery.includes('+20')) total += 20;
  const address = addr.value || '';
  const body = { customer: address || 'Client Web', type: delivery, address, items, total };
  const r = await fetch(`${API}/create-order`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.ok){
    alert('Commande créée #' + j.id + (j.discount?(' - Remise fidélité: '+j.discount+'€'):'') );
    CART = {}; updateBadge(); document.getElementById('cartSheet').classList.add('hidden');
  }else{
    alert('Erreur: ' + (j.error||'inconnue'));
  }
};

// ---- Avis (localStorage) ----
const REV_KEY = 'boutique.reviews';
function loadReviews(){ try{ return JSON.parse(localStorage.getItem(REV_KEY)||'[]'); }catch{ return []; } }
function saveReviews(list){ localStorage.setItem(REV_KEY, JSON.stringify(list)); }
function renderReviews(){
  const box = document.getElementById('reviews'); const list = loadReviews();
  if(!list.length){ box.innerHTML = '<div class="muted">Aucun avis pour le moment.</div>'; return; }
  box.innerHTML = list.map(r=>`<div class="card p" style="margin:8px 0"><b>${r.name||'Anonyme'}</b> — ${'⭐'.repeat(r.stars)}<div class="muted small">${new Date(r.date).toLocaleString('fr-FR')}</div><div style="margin-top:6px">${r.text}</div></div>`).join('');
}
document.getElementById('revSubmit').onclick = ()=>{
  const list = loadReviews();
  list.unshift({ name:document.getElementById('revName').value.trim(), text:document.getElementById('revText').value.trim(), stars:+document.getElementById('revStars').value, date:Date.now() });
  saveReviews(list); document.getElementById('revText').value=''; renderReviews();
};
renderReviews();

/* === Gestion ouverture / fermeture du panier (version corrigée iOS/Telegram) === */

// Sélecteurs
const sheet   = document.getElementById('cartSheet');   // <section id="cartSheet" class="sheet hidden">
const cartBtn = document.getElementById('cartBtn');     // bouton panier dans le header
const closeCart = document.getElementById('closeCart'); // bouton "x" dans le sheet

// Mémorisation du scroll du fond
let scrollPos = 0;

function openSheet() {
  if (!sheet) return;

  // Affiche le sheet
  sheet.classList.remove('hidden');

  // Fige le fond et mémorise la position (anti-saut iOS)
  scrollPos = window.scrollY || document.documentElement.scrollTop || 0;
  document.body.style.top = `-${scrollPos}px`;
  document.body.classList.add('modal-open');
}

function hideSheet() {
  if (!sheet) return;

  // Cache le sheet
  sheet.classList.add('hidden');

  // Défige le fond et restaure la position
  document.body.classList.remove('modal-open');
  document.body.style.top = '';
  window.scrollTo(0, scrollPos);
}

// Listeners d’ouverture/fermeture
cartBtn?.addEventListener('click', openSheet);
closeCart?.addEventListener('click', hideSheet);

// Cliquer sur l’overlay (fond noir du sheet) ferme le panier
sheet?.addEventListener('click', (e) => {
  // si on clique exactement sur le conteneur externe (et pas la carte)
  if (e.target === sheet) hideSheet();
});

// ---------- Rustines iOS / Telegram -----------

// Empêche de scroller le fond quand le panier est ouvert
const mainEl = document.querySelector('main');
mainEl?.addEventListener('touchmove', (e) => {
  if (document.body.classList.contains('modal-open')) {
    e.preventDefault();
  }
}, { passive: false });

// Laisse scroller l’intérieur du sheet sans propager au fond
const sheetCard = sheet?.querySelector('.sheet-card');
sheetCard?.addEventListener('touchmove', (e) => {
  e.stopPropagation();
}, { passive: false });
