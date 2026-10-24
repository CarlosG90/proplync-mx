/* agencias.js — behaviour for /agencias (moved out of the home page's inline script).
   WHY a file: the inline copy could not be cached and was parsed on every visit to a page
   that no longer needs it. The Soluciones dropdown and the featured-listings strip were
   dropped with their markup. Needs escape.js and i18n.js (lang, setLang, bd/ba/per...). */
/* ---------- header scroll effect ---------- */
  (function(){
    const header = document.querySelector('header');
    let ticking = false;
    window.addEventListener('scroll', function(){
      if(!ticking){
        requestAnimationFrame(function(){
          header.classList.toggle('scrolled', window.scrollY > 40);
          ticking = false;
        });
        ticking = true;
      }
    });
  })();


  /* ---------- homepage-specific: wire lang change to page components ---------- */
  document.addEventListener('langchange', function(){
    renderProperties();
    updateHeroListing();
    renderPreview();
    updateSidePanel();
    calc();
  });

  /* ---------- properties (EasyBroker API schema) ---------- */
  const LISTINGS_ENDPOINT = '/api/search';
  let properties = [
    {public_id:'EB-T2451', title_es:'Departamento en preventa', title_en:'Pre-sale apartment', town:'Tulum', neighborhood:'Aldea Zama', bedrooms:2, bathrooms:2, parking:1, size:78, operation:'sale', currency:'USD', amount:245000, formatted:'245,000', image:'https://images.pexels.com/photos/5563469/pexels-photo-5563469.jpeg?auto=compress&cs=tinysrgb&w=800', scene:'condo', photoQuery:'modern condo balcony jungle', lat:20.2114, lng:-87.4654},
    {public_id:'EB-P8830', title_es:'Casa con alberca en Playacar', title_en:'House with pool in Playacar', town:'Playa del Carmen', neighborhood:'Playacar Fase II', bedrooms:3, bathrooms:4, parking:2, size:240, operation:'sale', currency:'USD', amount:685000, formatted:'685,000', image:'https://images.pexels.com/photos/8134849/pexels-photo-8134849.jpeg?auto=compress&cs=tinysrgb&w=800', scene:'pool', photoQuery:'luxury house swimming pool', lat:20.6116, lng:-87.0739},
    {public_id:'EB-M1207', title_es:'Studio frente al mar', title_en:'Beachfront studio', town:'Puerto Morelos', neighborhood:'Zona Hotelera', bedrooms:1, bathrooms:1, parking:1, size:45, operation:'sale', currency:'USD', amount:189000, formatted:'189,000', image:'https://images.pexels.com/photos/6312076/pexels-photo-6312076.jpeg?auto=compress&cs=tinysrgb&w=800', scene:'studio', photoQuery:'beachfront studio apartment interior', lat:20.8460, lng:-86.8756},
    {public_id:'EB-C4062', title_es:'Penthouse vista al Caribe', title_en:'Penthouse with Caribbean view', town:'Cancun', neighborhood:'Puerto Cancun', bedrooms:3, bathrooms:3, parking:2, size:180, operation:'sale', currency:'USD', amount:1150000, formatted:'1,150,000', image:'https://images.pexels.com/photos/6775268/pexels-photo-6775268.jpeg?auto=compress&cs=tinysrgb&w=800', scene:'penthouse', photoQuery:'penthouse ocean view terrace', lat:21.1394, lng:-86.7649},
    {public_id:'EB-P5519', title_es:'Departamento amueblado', title_en:'Furnished apartment', town:'Playa del Carmen', neighborhood:'Centro', bedrooms:2, bathrooms:2, parking:1, size:90, operation:'rental', currency:'USD', amount:2200, formatted:'2,200', image:'https://images.pexels.com/photos/6969824/pexels-photo-6969824.jpeg?auto=compress&cs=tinysrgb&w=800', scene:'apartment', photoQuery:'furnished apartment living room modern', lat:20.6296, lng:-87.0739},
    {public_id:'EB-T3388', title_es:'Villa en la selva', title_en:'Villa in the jungle', town:'Tulum', neighborhood:'Region 15', bedrooms:4, bathrooms:4, parking:3, size:320, operation:'sale', currency:'USD', amount:890000, formatted:'890,000', image:'https://images.pexels.com/photos/4940760/pexels-photo-4940760.jpeg?auto=compress&cs=tinysrgb&w=800', scene:'villa', photoQuery:'jungle villa mexico exterior', lat:20.1950, lng:-87.4550},
    {public_id:'EB-P9214', title_es:'Penthouse con vista al mar en Coco Beach', title_en:'Oceanview penthouse in Coco Beach', town:'Playa del Carmen', neighborhood:'Coco Beach', bedrooms:2, bathrooms:2, parking:1, size:204, operation:'sale', currency:'USD', amount:839000, formatted:'839,000', image:'https://images.pexels.com/photos/36362/pexels-photo.jpg?auto=compress&cs=tinysrgb&w=800', scene:'penthouse', photoQuery:'luxury penthouse rooftop ocean view', lat:20.6455, lng:-87.0625},
    {public_id:'EB-T6720', title_es:'Estudio frente al mar en Tankah Bay', title_en:'Beachfront studio in Tankah Bay', town:'Tulum', neighborhood:'Tankah Bay', bedrooms:1, bathrooms:1, parking:1, size:51, operation:'sale', currency:'USD', amount:672190, formatted:'672,190', image:'https://images.pexels.com/photos/31688473/pexels-photo-31688473.jpeg?auto=compress&cs=tinysrgb&w=800', scene:'studio', photoQuery:'beachfront studio apartment interior tulum', lat:20.2970, lng:-87.4280}
  ];
  let activeProp = properties[0];
  let opFilter = 'all';

  /* Built-in illustrated property photos (encoded SVG) so sample cards always
     show an image with no external requests. Real EasyBroker photos (p.image)
     override these automatically in production. */
  function sceneSVG(type){
    const C={sea:'#2d8a85',seaD:'#1f6b67',sand:'#f0ebe3',gold:'#c9a96e',ink:'#0a1628',jungle:'#1f7a4d',jgl2:'#2e9d63',jgl3:'#15633c',teal:'#1f6b67',aqua:'#5ec4be',wall:'#f8f5f0',wall2:'#e4ddd1'};
    let skyA='#bfeee6', skyB='#eaf7f2';
    if(type==='penthouse'){skyA='#1f6b67'; skyB='#dcc599';}
    if(type==='villa'){skyA='#cdeee0'; skyB='#eaf7ef';}
    const palm=(x,y,s)=>`<g transform='translate(${x},${y}) scale(${s})'><path d='M0 0C-3-30-2-55 2-80' stroke='#7a5230' stroke-width='5' fill='none' stroke-linecap='round'/><g fill='${C.jgl2}'><path d='M2-80C-20-95-40-92-52-80C-30-84-12-80 2-70Z'/><path d='M2-80C24-95 44-92 56-80C34-84 14-80 2-70Z'/><path d='M2-80C-14-104-10-120 4-128C2-110 4-92 4-78Z'/><path d='M2-80C18-104 14-120 0-128C2-110 0-92 0-78Z'/><path d='M2-80C-30-86-46-70-50-56C-34-70-14-76 2-74Z'/><path d='M2-80C34-86 50-70 54-56C38-70 18-76 2-74Z'/></g></g>`;
    const win=(x,y,c,cols,rows,gx,gy,w,h)=>{let r='';for(let i=0;i<cols;i++)for(let j=0;j<rows;j++)r+=`<rect x='${x+i*gx}' y='${y+j*gy}' width='${w}' height='${h}' rx='1' fill='${c}'/>`;return r;};
    const sun=(x,y,r)=>`<circle cx='${x}' cy='${y}' r='${r+8}' fill='${C.gold}' opacity='.18'/><circle cx='${x}' cy='${y}' r='${r}' fill='${C.gold}'/>`;
    const blob=b=>`<circle cx='${b[0]}' cy='${b[1]}' r='${b[2]}' fill='${b[3]}'/>`;
    let inner='';
    switch(type){
      case 'studio':
        inner = sun(322,72,26)
          + `<rect x='0' y='150' width='400' height='60' fill='${C.seaD}'/>`
          + `<rect x='0' y='150' width='400' height='12' fill='${C.aqua}' opacity='.55'/>`
          + `<path d='M0 205 Q200 190 400 205 L400 300 L0 300 Z' fill='${C.sand}'/>`
          + `<path d='M0 208 Q200 194 400 208' stroke='#fff' stroke-width='3' fill='none' opacity='.6'/>`
          + `<g><rect x='243' y='196' width='4' height='20' fill='#7a5230'/><rect x='285' y='196' width='4' height='20' fill='#7a5230'/><path d='M232 198 L300 198 L280 176 L252 176 Z' fill='#b9863f'/><path d='M232 198 L300 198 L266 186 Z' fill='#a9752f'/></g>`
          + palm(78,232,1.15);
        break;
      case 'penthouse':
        inner = sun(300,150,30)
          + `<rect x='0' y='176' width='400' height='124' fill='${C.seaD}'/>`
          + `<rect x='150' y='176' width='70' height='124' fill='${C.gold}' opacity='.3'/>`
          + `<g fill='${C.teal}'><rect x='40' y='96' width='46' height='104'/><rect x='96' y='60' width='40' height='140'/><rect x='150' y='110' width='34' height='90'/><rect x='250' y='80' width='44' height='120'/><rect x='300' y='120' width='36' height='80'/></g>`
          + win(48,104,C.gold,3,6,14,15,6,8) + win(104,70,C.gold,2,8,16,15,7,8) + win(256,90,C.gold,3,7,13,15,6,8);
        break;
      case 'pool':
        inner = sun(70,66,24)
          + `<rect x='0' y='210' width='400' height='90' fill='${C.sand}'/>`
          + palm(40,214,1) + palm(360,210,1.05)
          + `<rect x='150' y='120' width='150' height='95' fill='${C.wall}'/>`
          + `<rect x='150' y='120' width='150' height='16' fill='${C.teal}'/>`
          + `<rect x='214' y='170' width='24' height='45' fill='${C.teal}'/>`
          + win(166,150,C.aqua,1,1,0,0,26,20) + win(258,150,C.aqua,1,1,0,0,26,20)
          + `<rect x='96' y='240' width='210' height='44' rx='10' fill='${C.aqua}'/>`
          + `<rect x='96' y='240' width='210' height='14' rx='7' fill='#bdeee6' opacity='.6'/>`;
        break;
      case 'condo':
        inner = sun(330,64,22)
          + `<rect x='0' y='236' width='400' height='64' fill='${C.jgl3}'/>`
          + `<rect x='150' y='70' width='120' height='170' fill='${C.wall}'/>`
          + `<rect x='150' y='70' width='120' height='170' fill='none' stroke='${C.teal}' stroke-width='3'/>`
          + `<g stroke='${C.teal}' stroke-width='3'>`+[100,130,160,190,220].map(y=>`<line x1='150' y1='${y}' x2='270' y2='${y}'/>`).join('')+`</g>`
          + `<rect x='150' y='70' width='30' height='170' fill='${C.aqua}' opacity='.25'/>`
          + palm(78,246,1.1) + palm(330,244,1.05);
        break;
      case 'apartment':
        inner = `<rect x='0' y='250' width='400' height='50' fill='${C.wall2}'/>`
          + `<rect x='30' y='150' width='80' height='104' fill='#dfeae6'/>`
          + `<rect x='118' y='110' width='90' height='144' fill='#eef3ef'/>`
          + `<rect x='216' y='140' width='70' height='114' fill='#d9e3df'/>`
          + `<rect x='294' y='96' width='84' height='158' fill='#e7efe9'/>`
          + win(40,162,C.teal,3,4,24,22,12,12) + win(128,122,C.teal,3,6,26,22,12,12)
          + win(226,152,C.teal,2,4,26,22,12,12) + win(306,110,C.teal,3,6,24,22,12,12)
          + `<rect x='0' y='276' width='400' height='6' fill='${C.ink}' opacity='.25'/>` + palm(372,278,.75);
        break;
      case 'villa':
      default:
        inner = [[40,150,60,C.jgl2],[110,130,70,C.jungle],[190,150,64,C.jgl2],[260,128,72,C.jungle],[330,150,62,C.jgl2]].map(blob).join('')
          + `<rect x='168' y='150' width='90' height='70' fill='${C.wall}'/><path d='M160 152 L266 152 L213 120 Z' fill='#b9863f'/>`
          + win(182,168,C.teal,2,1,44,0,22,26)
          + [[10,210,60,C.jungle],[80,205,70,C.jgl3],[220,210,74,C.jgl3],[330,205,66,C.jgl3]].map(blob).join('')
          + `<rect x='0' y='252' width='400' height='48' fill='${C.jgl3}'/>`;
        break;
    }
    const svg=`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 400 300'><defs><linearGradient id='sk' x1='0' y1='0' x2='0' y2='1'><stop offset='0' stop-color='${skyA}'/><stop offset='1' stop-color='${skyB}'/></linearGradient></defs><rect width='400' height='300' fill='url(#sk)'/>${inner}</svg>`;
    return "data:image/svg+xml,"+encodeURIComponent(svg);
  }
  /* A listing photo is agency data and goes through cssUrl; the SVG fallback is
     drawn by sceneSVG above and is ours. */
  const photoFor = p => p.image ? cssUrl(p.image) : sceneSVG(p.scene||'villa');

  function cardHTML(p){
    return '<article class="pcard" onclick="selectProperty(\''+p.public_id+'\')">'+
      '<div class="pcard-photo" style="background-color:#142237;background-image:linear-gradient(180deg,rgba(10,22,40,.18),rgba(10,22,40,0) 42%,rgba(10,22,40,0) 72%,rgba(10,22,40,.12)),url(\''+photoFor(p)+'\')">'+
        '<span class="pcard-badge '+(p.operation==='sale'?'badge-sale':'badge-rental')+'">'+opLabel(p)+'</span>'+
        '<span class="pcard-id">'+p.public_id+'</span>'+
      '</div>'+
      '<div class="pcard-body">'+
        '<div class="pcard-loc">'+escapeHtml(p.neighborhood)+' &middot; '+escapeHtml(p.town)+'</div>'+
        '<div class="pcard-title">'+escapeHtml(lang==='es'?p.title_es:p.title_en)+'</div>'+
        '<div class="pcard-specs"><span>'+bd(p)+'</span><span>'+ba(p)+'</span><span>'+p.size+' m&sup2;</span></div>'+
        '<div class="pcard-foot"><span class="pcard-price">'+escapeHtml(p.currency)+' $'+escapeHtml(p.formatted)+(per(p)?' <small>'+per(p)+'</small>':'')+'</span></div>'+
        '<button class="pcard-gen" onclick="event.stopPropagation();loadProperty(\''+p.public_id+'\')">'+(lang==='es'?'Generar 7 piezas':'Generate 7 pieces')+' &rarr;</button>'+
      '</div></article>';
  }
  function renderProperties(){
    const list = properties.filter(p=>opFilter==='all'||p.operation===opFilter);
    document.getElementById('pgrid').innerHTML = list.map(cardHTML).join('');
  }
  function selectProperty(id){
    activeProp = properties.find(p=>p.public_id===id) || activeProp;
    updateSidePanel();
  }
  async function loadListings(){
    if(!LISTINGS_ENDPOINT) return;
    try{
      const r = await fetch(LISTINGS_ENDPOINT, {headers:{'accept':'application/json'}});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const data = await r.json();
      const live = data.listings || data;
      if(Array.isArray(live) && live.length){
        properties = live;
        activeProp = properties[0];
        renderProperties();
        updateHeroListing();
        renderPreview();
        updateSidePanel();
      }
    }catch(e){
      console.warn('[Proplync] Live listings unavailable, using sample data:', e.message);
    }
  }

  const PHOTOS_ENDPOINT = '/api/photos';
  async function loadPhotos(){
    const needing = properties.filter(p=>!p.image && p.photoQuery);
    if(!needing.length) return;
    try{
      const q = needing.map(p=>p.photoQuery).join(',');
      const r = await fetch(PHOTOS_ENDPOINT+'?q='+encodeURIComponent(q), {headers:{'accept':'application/json'}});
      if(!r.ok) throw new Error('HTTP '+r.status);
      const {photos} = await r.json();
      needing.forEach((p,i)=>{ if(photos[i] && photos[i].image) p.image = photos[i].image; });
      renderProperties();
      updateHeroListing();
      renderPreview();
    }catch(e){
      console.warn('[Proplync] Real photos unavailable, using illustrated samples:', e.message);
    }
  }
  function filterProps(el){
    opFilter = el.getAttribute('data-op');
    document.querySelectorAll('#pfilter button').forEach(b=>b.classList.remove('on'));
    el.classList.add('on');
    renderProperties();
  }
  function loadProperty(id){
    /* Navigate to the full generator page with the property pre-loaded */
    window.location.href = '/generate?id=' + encodeURIComponent(id);
  }

  /* ---------- side panel ---------- */
  const GEOCODE_ENDPOINT = '/api/geocode';
  const AMENITIES_ENDPOINT = '/api/amenities';
  const DESCRIBE_ENDPOINT = '/api/describe';

  async function updateSidePanel(){
    const p = activeProp;
    document.getElementById('ps-title').textContent = lang==='es'?p.title_es:p.title_en;
    document.getElementById('ps-ai-out').innerHTML = '';
    document.getElementById('ps-ai-btn').disabled = false;

    let {lat, lng} = p;
    if(lat==null || lng==null){
      try{
        /* Same two-pass query as dashboard.html. "Quintana Roo" used to be
           hardcoded here too, which silently resolved any out-of-state
           property to a coordinate in the Riviera Maya. */
        const queries = [
          [p.neighborhood, p.town, 'Mexico'].filter(Boolean).join(', '),
          [p.town, 'Mexico'].filter(Boolean).join(', ')
        ];
        for(const q of queries){
          const r = await fetch(GEOCODE_ENDPOINT+'?q='+encodeURIComponent(q));
          if(!r.ok) throw new Error('HTTP '+r.status);
          const d = await r.json();
          if(d.lat!=null && d.lng!=null){ lat=d.lat; lng=d.lng; p.lat=lat; p.lng=lng; break; }
        }
      }catch(e){
        console.warn('[Proplync] geocode unavailable:', e.message);
      }
    }

    const mapFrame = document.getElementById('ps-map-frame');
    const amenBox = document.getElementById('ps-amenities');
    if(lat!=null && lng!=null){
      const d=0.012;
      mapFrame.src = 'https://www.openstreetmap.org/export/embed.html?bbox='+(lng-d)+'%2C'+(lat-d)+'%2C'+(lng+d)+'%2C'+(lat+d)+'&layer=mapnik&marker='+lat+'%2C'+lng;
      mapFrame.style.display = 'block';
      loadAmenities(lat, lng);
    }else{
      mapFrame.style.display = 'none';
      amenBox.innerHTML = '';
    }
  }

  async function loadAmenities(lat, lng){
    const box = document.getElementById('ps-amenities');
    box.innerHTML = '<p class="ps-loading">'+(lang==='es'?'Buscando lugares cercanos...':'Finding nearby places...')+'</p>';
    try{
      const r = await fetch(AMENITIES_ENDPOINT+'?lat='+lat+'&lng='+lng);
      if(!r.ok) throw new Error('HTTP '+r.status);
      const {places} = await r.json();
      if(!places || !places.length){ box.innerHTML=''; return; }
      box.innerHTML = places.slice(0,6).map(pl=>
        '<div class="ps-poi"><span class="ps-poi-cat">'+escapeHtml(pl.category)+'</span><span class="ps-poi-name">'+escapeHtml(pl.name)+'</span><span class="ps-poi-dist">'+escapeHtml(pl.distance_m)+' m</span></div>'
      ).join('');
    }catch(e){
      box.innerHTML = '';
      console.warn('[Proplync] amenities unavailable:', e.message);
    }
  }

  async function generateDescription(){
    const btn = document.getElementById('ps-ai-btn');
    const out = document.getElementById('ps-ai-out');
    btn.disabled = true;
    out.innerHTML = '<p class="ps-loading">'+(lang==='es'?'Generando con IA...':'Generating with AI...')+'</p>';
    try{
      const p = activeProp;
      const r = await fetch(DESCRIBE_ENDPOINT, {
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({
          title: lang==='es'?p.title_es:p.title_en,
          town:p.town, neighborhood:p.neighborhood,
          bedrooms:p.bedrooms, bathrooms:p.bathrooms, size:p.size,
          operation:p.operation, currency:p.currency, amount:p.amount,
          lang
        })
      });
      if(!r.ok) throw new Error('HTTP '+r.status);
      const {description} = await r.json();
      out.innerHTML = '<p class="ps-ai-text">'+escapeHtml(description)+'</p><span class="ps-ai-credit">Powered by Groq &middot; Llama 3.3</span>';
    }catch(e){
      out.innerHTML = '<p class="ps-error">'+(lang==='es'?'No se pudo generar la descripcion. Intenta de nuevo.':'Could not generate the description. Try again.')+'</p>';
      console.warn('[Proplync] describe unavailable:', e.message);
    }finally{
      btn.disabled = false;
    }
  }
  function updateHeroListing(){
    const p=activeProp;
    document.getElementById('d-title').textContent = lang==='es'?p.title_es:p.title_en;
    document.getElementById('d-loc').textContent = (p.town+' · '+p.neighborhood).toUpperCase();
    document.getElementById('d-specs').innerHTML = '<span>'+bd(p)+'</span><span>'+ba(p)+'</span><span>'+p.size+' m²</span>';
    document.getElementById('d-price').innerHTML = escapeHtml(p.currency)+'<br>$'+escapeHtml(p.formatted)+(per(p)?'<br><small style="font-size:.58rem;opacity:.8">'+per(p)+'</small>':'');
    document.getElementById('d-photo').style.cssText += ';background-image:linear-gradient(150deg,rgba(10,22,40,.12),rgba(10,22,40,.22)),url(\''+photoFor(p)+'\');background-size:cover;background-position:center';
  }

  /* ---------- signature demo previews (property-aware) ---------- */
  const previews = {
    es:{
      pdf:{tag:'PDF', title:'{T}', body:'Ficha tecnica con precio, superficie, recamaras, amenidades y contacto en {L} — maquetada con tu marca.'},
      post:{tag:'Instagram', title:'{T}', body:'Publicacion con foto principal, copy comercial y CTA. Ubicacion: {L}. Escribenos por DM.'},
      carousel:{tag:'Carrusel · 5', title:'Cinco slides, una historia', body:'Portada → ubicacion → interior → amenidades → contacto. {L}, una idea por diapositiva.', dots:true},
      story:{tag:'Story · 9:16', title:'Story vertical lista', body:'Pantalla completa con precio, sticker de {L} y CTA para agendar visita.', pills:['9:16','Swipe up']},
      email:{tag:'Email · HTML', title:'Nueva propiedad para tu base', body:'Correo listo para el CRM con la ficha de {T} y boton "Agendar visita".', pills:['CRM','HTML']},
      video:{tag:'Video · 9:16', title:'Reel con fotos, texto y locucion', body:'Recorrido vertical de {T} compuesto con FFmpeg — musica y voz opcional.', play:true}
    },
    en:{
      pdf:{tag:'PDF', title:'{T}', body:'Fact sheet with price, area, bedrooms, amenities, and contact in {L} — laid out with your brand.'},
      post:{tag:'Instagram', title:'{T}', body:'Post with main image, sales copy, and CTA. Location: {L}. DM us.'},
      carousel:{tag:'Carousel · 5', title:'Five slides, one story', body:'Cover → location → interior → amenities → contact. {L}, one idea per slide.', dots:true},
      story:{tag:'Story · 9:16', title:'Vertical story, ready', body:'Full-screen with price, a {L} location sticker, and a CTA to book a viewing.', pills:['9:16','Swipe up']},
      email:{tag:'Email · HTML', title:'New listing for your database', body:'CRM-ready email with the {T} fact sheet and a "Book a viewing" button.', pills:['CRM','HTML']},
      video:{tag:'Video · 9:16', title:'Reel with photos, text & voiceover', body:'Vertical walkthrough of {T} composed with FFmpeg — optional music and voice.', play:true}
    }
  };
  let currentFmt='pdf';
  function pick(el){
    document.querySelectorAll('.chip').forEach(c=>c.classList.remove('on'));
    el.classList.add('on');
    currentFmt=el.getAttribute('data-fmt');
    renderPreview();
  }
  function renderPreview(){
    const p=activeProp;
    /* Escaped once here: every template below splices these into markup. */
    const L=escapeHtml(p.neighborhood+', '+p.town);
    const T=escapeHtml((lang==='es'?p.title_es:p.title_en)+' · '+p.neighborhood);
    const d=previews[lang][currentFmt];
    const title=d.title.replace('{T}',T).replace('{L}',L);
    const body=d.body.replace('{T}',T).replace('{L}',L);
    let pills=d.pills;
    if(currentFmt==='pdf'){pills=[bd(p),ba(p),p.size+' m²',priceStr(p)];}
    if(currentFmt==='post'){pills=['#'+p.town.replace(/\s+/g,''),'#RivieraMaya',p.operation==='sale'?(lang==='es'?'#Venta':'#ForSale'):(lang==='es'?'#Renta':'#ForRent')];}
    const photo=photoFor(p);
    const shortTitle=escapeHtml(lang==='es'?p.title_es:p.title_en);
    const price=escapeHtml(priceStr(p));

    let thumb='';
    if(currentFmt==='post'){
      thumb='<div class="pv-thumb square" style="background-image:url(\''+photo+'\')"><div class="pv-thumb-overlay"></div><span class="pv-thumb-price">'+price+'</span><div class="pv-thumb-cap">'+shortTitle+'</div></div>';
    }else if(currentFmt==='story'){
      thumb='<div class="pv-thumb tall" style="background-image:url(\''+photo+'\')"><div class="pv-thumb-overlay"></div><span class="pv-thumb-price">'+price+'</span><div class="pv-thumb-cap">'+shortTitle+'</div></div>';
    }else if(currentFmt==='video'){
      thumb='<div class="pv-thumb" style="background-image:url(\''+photo+'\')"><div class="pv-thumb-overlay"></div><div class="pv-thumb-play"><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></div></div>';
    }else if(currentFmt==='pdf'){
      thumb='<div class="pv-thumb" style="background-image:url(\''+photo+'\')"><div class="pv-thumb-overlay"></div></div>';
    }else if(currentFmt==='carousel'){
      const seq=[
        {style:'background-image:url(\''+photo+'\')',ov:'background:linear-gradient(180deg,rgba(10,22,40,.05),rgba(10,22,40,.7))',c:'#fff'},
        {style:'background:#0a1628',ov:'',c:'var(--gold)'},
        {style:'background:#f0ebe3',ov:'',c:'var(--gold-deep)'},
        {style:'background:#0a1628',ov:'',c:'#fff'},
        {style:'background:linear-gradient(160deg,#c9a96e,#b08c4a)',ov:'',c:'var(--ink)'}
      ];
      thumb='<div class="pv-mini-strip">'+seq.map((s,i)=>'<div class="pv-mini-slide" style="'+s.style+'">'+(s.ov?'<div class="ov" style="'+s.ov+'"></div>':'')+'<span style="color:'+s.c+'">'+(i+1)+'/5</span></div>').join('')+'</div>';
    }

    /* pv-tag floats top-right of the whole box — only show it when there's no
       photo thumb, since the thumbs already carry their own top-right badge
       (price) or communicate the format visually (mini-strip, play button). */
    let html=thumb+(thumb?'':'<span class="pv-tag">'+d.tag+'</span>')+'<div class="pv-title">'+title+'</div><div class="pv-body">'+body+'</div>';
    if(pills){html+='<div class="pv-row">'+pills.map(x=>'<span class="pv-pill">'+escapeHtml(x)+'</span>').join('')+'</div>';}
    if(d.dots){html+='<div class="pv-dots"><i class="a"></i><i></i><i></i><i></i><i></i></div>';}
    document.getElementById('preview').innerHTML=html;
  }

  /* ---------- ROI ---------- */
  let curr='USD';
  const rates={USD:{sym:'$',def:25,max:120,step:1,loc:'en-US'},MXN:{sym:'$',def:350,max:1500,step:10,loc:'es-MX'}};
  function setCurr(c){
    curr=c;
    document.getElementById('usd').classList.toggle('on',c==='USD');
    document.getElementById('mxn').classList.toggle('on',c==='MXN');
    const r=document.getElementById('rate');
    r.max=rates[c].max; r.step=rates[c].step; r.value=rates[c].def;
    calc();
  }
  function fmtMoney(n){
    return rates[curr].sym+Math.round(n).toLocaleString(rates[curr].loc)+' '+curr;
  }
  function calc(){
    const props=+document.getElementById('props').value;
    const hours=+document.getElementById('hours').value;
    const rate=+document.getElementById('rate').value;
    document.getElementById('v-props').textContent=props;
    document.getElementById('v-hours').textContent=hours.toFixed(1);
    document.getElementById('v-rate').textContent=rates[curr].sym+rate.toLocaleString(rates[curr].loc);
    const monthHrs=props*hours;
    const month=monthHrs*rate;
    document.getElementById('out-month').textContent=fmtMoney(month);
    document.getElementById('out-year').textContent=fmtMoney(month*12);
    document.getElementById('out-hrs').textContent=monthHrs.toLocaleString(rates[curr].loc)+' h';
  }

  /* ---------- scroll reveal ---------- */
  const io=new IntersectionObserver((es)=>{
    es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});
  },{threshold:.1});
  document.querySelectorAll('.reveal').forEach(el=>io.observe(el));

  /* close mobile nav on link click */
  document.querySelectorAll('#navlinks a').forEach(a=>a.addEventListener('click',()=>document.getElementById('navlinks').classList.remove('open')));

  /* init */
  renderProperties();
  updateHeroListing();
  renderPreview();
  updateSidePanel();
  calc();
  loadListings();
  loadPhotos();

  /* ---------- contact form submission ---------- */
  function submitContact(e){
    e.preventDefault();
    const form = document.getElementById('contact-form');
    const data = Object.fromEntries(new FormData(form));
    // For now: send via mailto as fallback, show success state
    // In production: POST to /api/leads or a webhook
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    btn.textContent = lang === 'en' ? 'Sending...' : 'Enviando...';
    // Simulate send (replace with fetch('/api/leads', ...) when backend is ready)
    setTimeout(function(){
      form.style.display = 'none';
      var success = document.getElementById('contact-success');
      success.style.display = 'flex';
      // Also fire a mailto as backup so Carlos gets the lead
      var subject = encodeURIComponent('Diagnostico Proplync.mx — ' + (data.name || 'Lead'));
      var body = encodeURIComponent(
        'Nombre: ' + (data.name||'') + '\n' +
        'Empresa: ' + (data.company||'') + '\n' +
        'Email: ' + (data.email||'') + '\n' +
        'WhatsApp: ' + (data.phone||'') + '\n' +
        'Tipo: ' + (data.type||'') + '\n' +
        'Mensaje: ' + (data.message||'')
      );
      window.open('mailto:hola@proplync.mx?subject=' + subject + '&body=' + body, '_blank');
    }, 800);
  }

  /* ---------- textarea placeholder i18n ---------- */
  function updateTextareaPlaceholders(){
    document.querySelectorAll('textarea[data-'+lang+'-placeholder]').forEach(function(el){
      el.placeholder = el.getAttribute('data-'+lang+'-placeholder');
    });
  }
  updateTextareaPlaceholders();
  document.addEventListener('langchange', updateTextareaPlaceholders);
