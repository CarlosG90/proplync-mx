/* PropLync Finder · the hero object that comes apart
   ─────────────────────────────────────────────────────────────────
   WHY THIS EXISTS
   Finder's whole promise is that every property is taken apart and checked
   before a buyer ever sees it. Saying that in a paragraph is forgettable;
   letting someone pull the object apart with their own cursor is not. The hero
   demonstrates the product instead of describing it.

   WHY NOT A BLENDER MODEL
   The reference this came from exports a mesh from Blender. That would mean an
   asset pipeline, a multi-megabyte .glb and a build step, in a repo that has
   none of those on purpose. The same object is a procedural polyhedron: take an
   icosahedron, cut it into one panel per face, shrink each panel toward its own
   centre so the seams show, and push each one out along its normal.

   WHY A CUSTOM SHADER
   The explode moves thousands of vertices every frame. On the CPU that rewrites
   a buffer per frame; here one uniform moves everything on the GPU. The
   lighting is hand-rolled (one directional term plus a rim) so the scene needs
   no lights and no environment map to look like metal.

   IT MUST NEVER BREAK THE PAGE. No WebGL, a lost context, Three.js blocked by a
   network or a CSP: in every case the canvas hides and the CSS fallback behind
   it shows. A buyer landing that renders a black hole is worse than one with no
   3D at all. */

(function () {
  'use strict';

  var THREE_SRC = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';

  var root = document.getElementById('hero3d');
  if (!root) return;

  var canvas = root.querySelector('canvas');
  var statusEl = document.getElementById('hero3d-status');

  /* Reduced motion is not "animate slower": people set it because motion makes
     them ill. One static frame, no loop, no auto-spin. */
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function fail(why) {
    root.setAttribute('data-fallback', why);   // CSS reveals the poster
    if (canvas) canvas.style.display = 'none';
  }

  function hasWebGL() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext &&
        (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  if (!canvas || !hasWebGL()) { fail('no-webgl'); return; }

  /* Load Three.js only when the hero is near view. It is the heaviest thing on
     the page and the page must paint without it. */
  var started = false;
  function start() {
    if (started) return;
    started = true;
    var s = document.createElement('script');
    s.src = THREE_SRC;
    s.async = true;
    s.onload = function () { try { build(); } catch (e) { fail('error'); } };
    s.onerror = function () { fail('no-three'); };
    document.head.appendChild(s);
  }

  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); start(); }
    }, { rootMargin: '200px' });
    io.observe(root);
  } else {
    start();
  }

  function build() {
    var W = root.clientWidth, H = root.clientHeight;
    if (!W || !H) { fail('error'); return; }

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true });
    /* Cap the pixel ratio: a 3x phone would otherwise render nine times the
       pixels of a 1x screen for a decoration. */
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(W, H, false);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 100);
    camera.position.set(0, 0, 5.2);

    /* Fewer panels on a phone: detail 2 is 320 triangles, detail 1 is 80. The
       silhouette barely changes at small sizes; the fill rate does. */
    var detail = W < 560 ? 1 : 2;
    var geo = new THREE.IcosahedronGeometry(1.35, detail).toNonIndexed();

    var pos = geo.attributes.position;
    var faces = pos.count / 3;
    var centro = new Float32Array(pos.count * 3);
    var rand = new Float32Array(pos.count);
    var SHRINK = 0.82;                    // gap between panels, so seams read

    var a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), cen = new THREE.Vector3();
    for (var f = 0; f < faces; f++) {
      var i0 = f * 3;
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i0 + 1);
      c.fromBufferAttribute(pos, i0 + 2);
      cen.copy(a).add(b).add(c).multiplyScalar(1 / 3);
      var r = Math.random();
      for (var k = 0; k < 3; k++) {
        var v = k === 0 ? a : (k === 1 ? b : c);
        /* Pull each corner toward the panel's own centre. This is what turns a
           continuous sphere into separate tiles. */
        pos.setXYZ(i0 + k, cen.x + (v.x - cen.x) * SHRINK,
                           cen.y + (v.y - cen.y) * SHRINK,
                           cen.z + (v.z - cen.z) * SHRINK);
        centro[(i0 + k) * 3]     = cen.x;
        centro[(i0 + k) * 3 + 1] = cen.y;
        centro[(i0 + k) * 3 + 2] = cen.z;
        rand[i0 + k] = r;             // same value across the face, so it moves as one
      }
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();                       // flat, because non-indexed
    geo.setAttribute('aCentroid', new THREE.BufferAttribute(centro, 3));
    geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));

    var uniforms = {
      uExplode: { value: 0 },
      uInk:     { value: new THREE.Color('#16243c') },
      uGold:    { value: new THREE.Color('#c9a96e') },
      uAqua:    { value: new THREE.Color('#5ec4be') }
    };

    /* Shared displacement, so panels and their edges move as one object. */
    var DISPLACE = [
      'attribute vec3 aCentroid;',
      'attribute float aRand;',
      'uniform float uExplode;',
      'vec3 displaced(vec3 p, vec3 n){',
      /* Small numbers on purpose. The object should open like a shell with its
         pieces still clearly one object; at larger distances the panels simply
         leave the frame and it reads as debris, not as a thing taken apart. */
      '  float d = uExplode * (0.14 + aRand * 0.30);',
      '  vec3 outward = normalize(aCentroid);',
      '  return p + outward * d;',
      '}'
    ].join('\n');

    var panelMat = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: [
        DISPLACE,
        'varying vec3 vN; varying vec3 vV;',
        'void main(){',
        '  vN = normalize(normalMatrix * normal);',
        '  vec3 p = displaced(position, normal);',
        '  vec4 mv = modelViewMatrix * vec4(p,1.0);',
        '  vV = normalize(-mv.xyz);',
        '  gl_Position = projectionMatrix * mv;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uInk; uniform vec3 uGold; uniform vec3 uAqua;',
        'varying vec3 vN; varying vec3 vV;',
        'void main(){',
        '  vec3 N = normalize(vN);',
        '  if (!gl_FrontFacing) N = -N;',           // lit interior when open
        '  vec3 L = normalize(vec3(0.55, 0.8, 0.6));',
        '  float lam = max(dot(N, L), 0.0);',
        '  float fres = pow(1.0 - max(dot(N, normalize(vV)), 0.0), 2.4);',
        /* Mixing between two tones beats multiplying one. Multiplying a dark
           navy by a light factor keeps it dark navy; mixing lets a lit face
           actually travel toward a pale metal and gives the facets contrast. */
        '  vec3 col = mix(uInk * 0.55, vec3(0.42, 0.52, 0.66), lam);',
        '  col += uGold * fres * 0.85;',            // warm rim, the expensive look
        '  col += uAqua * pow(lam, 26.0) * 0.55;',  // one cool specular glint
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n'),
      side: THREE.DoubleSide
    });

    var panels = new THREE.Mesh(geo, panelMat);

    /* Edges get their own geometry rather than a wireframe flag, so they carry
       the same attributes and move with their panel. */
    var eg = new THREE.BufferGeometry();
    var ep = [], ec = [], er = [], en = [];
    var nAttr = geo.attributes.normal;
    for (var g = 0; g < faces; g++) {
      var base = g * 3;
      for (var e = 0; e < 3; e++) {
        var pair = [base + e, base + ((e + 1) % 3)];
        for (var q = 0; q < 2; q++) {
          var idx = pair[q];
          ep.push(pos.getX(idx), pos.getY(idx), pos.getZ(idx));
          ec.push(centro[idx * 3], centro[idx * 3 + 1], centro[idx * 3 + 2]);
          en.push(nAttr.getX(idx), nAttr.getY(idx), nAttr.getZ(idx));
          er.push(rand[idx]);
        }
      }
    }
    eg.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
    eg.setAttribute('aCentroid', new THREE.Float32BufferAttribute(ec, 3));
    eg.setAttribute('normal', new THREE.Float32BufferAttribute(en, 3));
    eg.setAttribute('aRand', new THREE.Float32BufferAttribute(er, 1));

    var edges = new THREE.LineSegments(eg, new THREE.ShaderMaterial({
      uniforms: uniforms,
      transparent: true,
      vertexShader: [
        DISPLACE,
        'void main(){',
        /* Lift the outline a hair off its own panel. Drawn at exactly the same
           depth the two z-fight and the edge disappears in bands as it turns. */
        '  vec3 p = displaced(position, normal) + normal * 0.012;',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uGold;',
        'void main(){ gl_FragColor = vec4(uGold * 1.15, 0.92); }'
      ].join('\n')
    }));

    var group = new THREE.Group();
    group.add(panels); group.add(edges);
    group.rotation.set(0.35, 0.6, 0);
    scene.add(group);

    /* ---------- state ---------- */
    var explode = 0, explodeTarget = 0;
    var zoom = 5.2, zoomTarget = 5.2;
    var spin = reduced ? 0 : 0.0016;
    var dragging = false, lastX = 0, lastY = 0, velX = 0, velY = 0;
    var paused = reduced, visible = true, rafId = null;

    function setOpen(open) {
      explodeTarget = open ? 1 : 0;
      root.setAttribute('data-open', open ? 'true' : 'false');
      var btn = document.getElementById('hero-toggle');
      if (btn) {
        var es = open ? 'Recomponer' : 'Desarmar';
        var en2 = open ? 'Put it back' : 'Take it apart';
        btn.setAttribute('data-es', es);
        btn.setAttribute('data-en', en2);
        btn.textContent = document.documentElement.lang === 'en' ? en2 : es;
      }
      if (statusEl) {
        statusEl.textContent = open
          ? (document.documentElement.lang === 'en' ? 'Open: every check is visible' : 'Abierta: cada comprobacion a la vista')
          : (document.documentElement.lang === 'en' ? 'Closed' : 'Cerrada');
      }
    }

    /* ---------- interaction ---------- */
    function down(x, y) { dragging = true; lastX = x; lastY = y; }
    function move(x, y) {
      if (!dragging) return;
      velY = (x - lastX) * 0.005;
      velX = (y - lastY) * 0.005;
      group.rotation.y += velY;
      group.rotation.x += velX;
      lastX = x; lastY = y;
    }
    function up() { dragging = false; }

    canvas.addEventListener('pointerdown', function (e) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      down(e.clientX, e.clientY);
    });
    canvas.addEventListener('pointermove', function (e) { move(e.clientX, e.clientY); });
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);

    var toggle = document.getElementById('hero-toggle');
    if (toggle) toggle.addEventListener('click', function () { setOpen(explodeTarget < 0.5); });

    var zoomBtn = document.getElementById('hero-zoom');
    if (zoomBtn) zoomBtn.addEventListener('click', function () { zoomTarget = zoomTarget > 4.4 ? 3.6 : 5.2; });

    var resetBtn = document.getElementById('hero-reset');
    if (resetBtn) resetBtn.addEventListener('click', function () {
      group.rotation.set(0.35, 0.6, 0); velX = velY = 0; zoomTarget = 5.2; setOpen(false);
    });

    var pauseBtn = document.getElementById('hero-pause');
    if (pauseBtn) pauseBtn.addEventListener('click', function () {
      paused = !paused;
      pauseBtn.setAttribute('aria-pressed', paused ? 'true' : 'false');
      if (!paused) loop();
    });

    /* The language toggle must relabel the button, because its text is owned by
       whichever of the two systems ran last. */
    document.addEventListener('langchange', function () { setOpen(explodeTarget > 0.5); });

    window.addEventListener('resize', function () {
      var w = root.clientWidth, h = root.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h; camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
      if (paused) renderer.render(scene, camera);
    });

    /* Stop the loop when nobody can see it: a hidden tab or a scrolled-past
       hero should not keep a GPU busy on a buyer's laptop battery. */
    document.addEventListener('visibilitychange', function () {
      visible = !document.hidden;
      if (visible && !paused) loop();
    });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        visible = es.some(function (e) { return e.isIntersecting; });
        if (visible && !paused) loop();
      }, { threshold: 0.01 }).observe(root);
    }

    canvas.addEventListener('webglcontextlost', function (ev) { ev.preventDefault(); fail('context-lost'); });

    function frame() {
      rafId = null;
      explode += (explodeTarget - explode) * 0.075;
      zoom += (zoomTarget - zoom) * 0.08;
      uniforms.uExplode.value = explode;
      camera.position.z = zoom;
      if (!dragging) {
        group.rotation.y += spin + velY;
        group.rotation.x += velX;
        velX *= 0.93; velY *= 0.93;             // inertia, then settle
      }
      renderer.render(scene, camera);
      if (!paused && visible) rafId = requestAnimationFrame(frame);
    }
    function loop() { if (rafId === null && !paused && visible) rafId = requestAnimationFrame(frame); }

    root.setAttribute('data-ready', 'true');
    setOpen(false);

    if (reduced) {
      /* One frame, slightly open so the idea still reads, then stop. */
      explode = explodeTarget = 0.42;
      uniforms.uExplode.value = explode;
      renderer.render(scene, camera);
    } else {
      loop();
    }
  }
})();
