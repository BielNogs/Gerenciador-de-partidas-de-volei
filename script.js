document.addEventListener('DOMContentLoaded', () => {
    const CONFIG = {
        TEAM_SIZE: 6,
        MIN_PLAYERS: 13,
        WIN_SCORE: 25,
        STORAGE_KEY: 'volei_v3_data',
        PLAYERS_KEY: 'volei_players',
        DAILY_TXT_KEY: 'volei_daily_txt',
        COLORS: [
            { n: "Laranja", c: "#FF7043" }, { n: "Verde", c: "#66BB6A" },
            { n: "Azul", c: "#42A5F5" },    { n: "Rosa", c: "#EC407A" },
            { n: "Roxo", c: "#AB47BC" },    { n: "Amarelo", c: "#FFEE58" },
            { n: "Ciano", c: "#26C6DA" }
        ]
    };

    let STATE = {
        teams: [],
        matches: [],
        results: [],
        score: { a: 0, b: 0 },
        matchActive: false,
        players: [], // {name, gender:'M'|'F', skill:1..5, present:boolean}
        teamStats: {}, // { teamName: { played: number, wins: number } }
        editingId: null,
        showActiveOnly: false,
        resultsFilter: { date: '', page: 1, pageSize: 10 },
        historyFilter: { page: 1, pageSize: 10 }
    };

    // --- Referências ---
    const $ = (id) => document.getElementById(id);
    const $$ = (sel) => document.querySelectorAll(sel);
    const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);
    const genId = () => (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8));
    function ensurePlayerIds() {
        let changed = false;
        STATE.players.forEach(p => { if (!p.id) { p.id = genId(); changed = true; } });
        if (changed) { try { savePlayers(); } catch(e) {} }
    }
    function ensureActiveFlag() {
        let changed = false;
        STATE.players.forEach(p => { if (typeof p.active === 'undefined') { p.active = true; changed = true; } });
        if (changed) { try { savePlayers(); } catch(e) {} }
    }

    // Normaliza nomes de cores dos times para Title Case e atualiza nome "X - Cor"
    function normalizeTeamColors() {
        if (!Array.isArray(STATE.teams)) return;
        const canon = (txt) => {
            if (!txt) return txt;
            const t = String(txt).trim();
            const found = CONFIG.COLORS.find(c => c.n.toLowerCase() === t.toLowerCase());
            return found ? found.n : t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
        };
        STATE.teams.forEach(t => {
            const fixed = canon(t.color);
            if (fixed !== t.color) {
                t.color = fixed;
                const m = String(t.name||'').match(/^(\d+)\s*-\s*(.+)$/);
                if (m) t.name = `${m[1]} - ${fixed}`;
            }
        });
    }

    // --- Navegação ---
    $$('.tab-link').forEach(btn => {
        btn.addEventListener('click', () => {
            $$('.tab-link').forEach(t => t.classList.remove('active'));
            $$('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            $(btn.dataset.tab).classList.add('active');
            // Persistência agora é local (IndexedDB); CSV é opcional.
        });
    });

    // Navegação por elementos com data-tab-target (cards e botões)
    document.querySelectorAll('[data-tab-target]').forEach(el => {
        el.addEventListener('click', () => {
            const target = el.dataset.tabTarget;
            const navBtn = Array.from($$('.tab-link')).find(b => b.dataset.tab === target);
            if (navBtn) navBtn.click();
        });
    });

    // Toasts amigáveis e não bloqueantes
    function showToast(message, type = 'info', timeout = 3000) {
        const cont = $('toast-container'); if (!cont) { console.log(message); return; }
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.innerHTML = `<span>${message}</span><span class="close">✖</span>`;
        cont.appendChild(el);
        const remove = () => { el.style.animation = 'fadeOut .2s ease-out'; setTimeout(()=>{ el.remove(); }, 180); };
        el.querySelector('.close').addEventListener('click', remove);
        setTimeout(remove, timeout);
    }

    // =========================================
    // IndexedDB: banco local
    // =========================================
    const DB = {
        db: null,
        open() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open('volei_db', 3);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    try { if (db.objectStoreNames.contains('players')) db.deleteObjectStore('players'); } catch(err) {}
                    db.createObjectStore('players', { keyPath: 'id' });
                    if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'date' });
                    if (!db.objectStoreNames.contains('results')) db.createObjectStore('results', { keyPath: 'id', autoIncrement: true });
                };
                req.onsuccess = () => { DB.db = req.result; resolve(DB.db); };
                req.onerror = () => reject(req.error);
            });
        },
        add(store, val) {
            return new Promise((resolve, reject) => {
                const tx = DB.db.transaction(store, 'readwrite');
                const req = tx.objectStore(store).add(val);
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
        },
        put(store, val) {
            return new Promise((resolve, reject) => {
                const tx = DB.db.transaction(store, 'readwrite');
                tx.objectStore(store).put(val);
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        },
        get(store, key) {
            return new Promise((resolve, reject) => {
                const tx = DB.db.transaction(store, 'readonly');
                const req = tx.objectStore(store).get(key);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => reject(req.error);
            });
        },
        getAll(store) {
            return new Promise((resolve, reject) => {
                const tx = DB.db.transaction(store, 'readonly');
                const req = tx.objectStore(store).getAll();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
            });
        },
        clear(store) {
            return new Promise((resolve, reject) => {
                const tx = DB.db.transaction(store, 'readwrite');
                tx.objectStore(store).clear();
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => reject(tx.error);
            });
        }
    };

    const todayKey = () => new Date().toISOString().split('T')[0];
    async function saveSessionField(field, value) {
        if (!DB.db) return;
        const key = todayKey();
        const sess = (await DB.get('sessions', key)) || { date: key };
        sess[field] = value;
        await DB.put('sessions', sess);
    }
    async function loadSessionToday() {
        if (!DB.db) return null;
        const sess = await DB.get('sessions', todayKey());
        if (sess) {
            STATE.results = sess.results || STATE.results;
            STATE.teamStats = sess.teamStats || STATE.teamStats;
            STATE.matches = sess.matches || STATE.matches;
            STATE.teams = sess.teams || STATE.teams;
        }
        normalizeTeamColors();
        return sess;
    }

    // =========================================
    // Supabase: conexão e sincronização remota
    // =========================================
    const SUPABASE = { client: null, online: false, url: '', key: '', warnedMissing: new Set() };
    function setSupabaseStatus(txt) {
        const elFooter = $('db-status-footer');
        if (elFooter) elFooter.textContent = 'BD: ' + txt;
    }
    async function initSupabase(url, key) {
        try {
            if (!url || !key) {
                setSupabaseStatus('offline');
                SUPABASE.client = null; SUPABASE.online = false;
                return false;
            }
            // evita múltiplas instâncias se já conectado com mesmas credenciais
            if (SUPABASE.client && SUPABASE.online && SUPABASE.url === url && SUPABASE.key === key) {
                setSupabaseStatus('online');
                return true;
            }
            // Usa UMD se presente; senão, importa ESM dinamicamente
            if (window.supabase && typeof window.supabase.createClient === 'function') {
                SUPABASE.client = window.supabase.createClient(url, key);
            } else {
                const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm');
                const createClient = mod.createClient || (mod.default?.createClient);
                if (!createClient) throw new Error('createClient não disponível no módulo Supabase');
                SUPABASE.client = createClient(url, key);
            }
            // ping simples: tentar listar jogadores
            const { data, error } = await SUPABASE.client.from('players').select('name').limit(1);
            if (error) {
                console.warn('Supabase erro ao conectar:', error);
                setSupabaseStatus('erro de conexão');
                SUPABASE.online = false;
                showToast('Falha ao conectar ao Supabase. Verifique configuração.', 'error', 4500);
                return false;
            }
            SUPABASE.online = true;
            SUPABASE.url = url; SUPABASE.key = key;
            setSupabaseStatus('online');
            return true;
        } catch (e) {
            console.warn('Supabase init exception:', e);
            setSupabaseStatus('offline');
            SUPABASE.client = null; SUPABASE.online = false;
            return false;
        }
    }
    async function syncPlayersFromRemote() {
        if (!SUPABASE.online) return null;
        const { data, error } = await SUPABASE.client.from('players').select('*');
        if (error) { console.warn('Supabase select players error:', error); return null; }
        if (Array.isArray(data)) {
            // merge por id; fallback por nome quando id ausente
            const localMap = new Map(STATE.players.map(p=>[(p.id||p.name.toLowerCase()), p]));
            const merged = new Map();
            data.forEach(r => {
                const key = r.id || (r.name||'').toLowerCase();
                const local = localMap.get(key) || localMap.get((r.name||'').toLowerCase());
                const present = local ? !!local.present : false;
                const createdAt = r.created_at || (local?.createdAt) || null;
                const active = (typeof r.active === 'boolean') ? r.active : (typeof local?.active === 'boolean' ? local.active : true);
                merged.set(key, { id: r.id || (local?.id) || genId(), name: r.name, gender: r.gender, skill: Number(r.skill)||3, present, active, createdAt });
            });
            // mantém locais não presentes no remoto
            STATE.players.forEach(p => { const key = p.id||p.name.toLowerCase(); if (!merged.has(key)) merged.set(key, p); });
            STATE.players = Array.from(merged.values());
            await savePlayers();
            return STATE.players;
        }
        return null;
    }
    async function pushPlayersToRemote() {
        if (!SUPABASE.online) return false;
        const rows = STATE.players.map(p=>({
            id: p.id,
            name: p.name,
            gender: p.gender,
            skill: p.skill,
            active: (p.active!==false),
            created_at: p.createdAt || new Date().toISOString()
        }));
        const { error } = await SUPABASE.client.from('players').upsert(rows, { onConflict: 'id' });
        if (error) {
            console.warn('Supabase upsert players error:', error);
            const msg = (error.message||'');
            const m = msg.match(/Could not find the '(\w+)' column/);
            if (m && !SUPABASE.warnedMissing.has(m[1])) {
                SUPABASE.warnedMissing.add(m[1]);
                const fix = (m[1]==='id')
                  ? "CREATE EXTENSION IF NOT EXISTS pgcrypto;\nALTER TABLE public.players ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid();\nALTER TABLE public.players ADD CONSTRAINT players_id_key UNIQUE (id);"
                  : (m[1]==='active')
                    ? "ALTER TABLE public.players ADD COLUMN IF NOT EXISTS active boolean DEFAULT true;"
                    : `ALTER TABLE public.players ADD COLUMN IF NOT EXISTS ${m[1]} timestamptz DEFAULT now();`;
                showToast(`Coluna '${m[1]}' ausente em 'players'. Verifique no Supabase Studio.`, 'error', 5000);
            }
            return false;
        }
        return true;
    }

    async function deletePlayerRemote(player) {
        if (!SUPABASE.online) return false;
        try {
            // tenta por id, se existir; em caso de falha, cai para nome
            if (player?.id) {
                const { error } = await SUPABASE.client.from('players').delete().eq('id', player.id);
                if (!error) return true;
                console.warn('Supabase delete by id falhou, tentando por nome. Detalhes:', error);
            }
            const { error: err2 } = await SUPABASE.client.from('players').delete().eq('name', player?.name || '');
            if (err2) { console.warn('Supabase delete by name error:', err2); return false; }
            return true;
        } catch(e) { console.warn('Supabase delete player exception:', e); return false; }
    }
    const SESSION_COLS = {
        teamStats: 'teamstats',
        presentList: 'presentlist',
        matches: 'matches',
        results: 'results',
        teams: 'teams'
    };
    async function saveSessionFieldRemote(field, value) {
        if (!SUPABASE.online) return false;
        const payload = { date: todayKey() };
        const col = SESSION_COLS[field] || field.toLowerCase();
        payload[col] = value;
        const { error } = await SUPABASE.client.from('sessions').upsert(payload, { onConflict: 'date' });
        if (error) {
            console.warn('Supabase upsert session error:', error);
            // mensagem típica: "Could not find the 'teamStats' column ..."
            const msg = (error.message||'');
            const m = msg.match(/Could not find the '(\w+)' column/);
            if (m && !SUPABASE.warnedMissing.has(m[1])) {
                SUPABASE.warnedMissing.add(m[1]);
                showToast(`Coluna '${m[1]}' ausente em 'sessions'. Ajuste via Supabase Studio.`, 'error', 5000);
            }
            return false;
        }
        return true;
    }
    async function loadSessionTodayRemote() {
        if (!SUPABASE.online) return null;
        const { data, error } = await SUPABASE.client.from('sessions').select('*').eq('date', todayKey()).maybeSingle();
        if (error) { console.warn('Supabase load session error:', error); return null; }
        if (data) {
            const g = (k) => data[k] ?? data[SESSION_COLS[k]];
            if (g('results')) STATE.results = g('results');
            if (g('teamStats')) STATE.teamStats = g('teamStats');
            if (g('matches')) STATE.matches = g('matches');
            if (g('teams')) STATE.teams = g('teams');
            return data;
        }
        return null;
    }
    // UI de conexão removida; conexão é automática via supabase.config.js

    // =========================================
    // JOGADORES: CRUD, CSV, LISTAGEM
    // =========================================
    async function savePlayers() {
        try {
            if (DB.db) {
                await DB.clear('players');
                await Promise.all(STATE.players.map(p => DB.put('players', p)));
            }
        } catch(e) {}
        localStorage.setItem(CONFIG.PLAYERS_KEY, JSON.stringify(STATE.players));
        renderPlayersList();
        if (SUPABASE.online) {
            try { await pushPlayersToRemote(); } catch(e) {}
        }
    }
    async function loadPlayers() {
        let loaded = false;
        // tenta carregar do remoto primeiro, se online
        if (SUPABASE.online) {
            try { const r = await syncPlayersFromRemote(); if (r) loaded = true; } catch(e) {}
        }
        if (DB.db) {
            try {
                const all = await DB.getAll('players');
                if (all && all.length) { STATE.players = all; loaded = true; }
            } catch(e) {}
        }
        if (!loaded) {
            const s = localStorage.getItem(CONFIG.PLAYERS_KEY);
            if (s) {
                try { STATE.players = JSON.parse(s) || []; } catch(e) { STATE.players = []; }
            }
        }
        ensurePlayerIds();
        ensureActiveFlag();
        renderPlayersList();
    }
    function addPlayer(name, gender, skill) {
        if (!name || !gender || !skill) return showToast('Preencha nome, sexo e habilidade.', 'error');
        const active = !!$('player-active')?.checked;
        STATE.players.push({ id: genId(), name: name.trim(), gender, skill: Number(skill), present: false, active, createdAt: new Date().toISOString() });
        savePlayers();
        $('player-name').value = '';
        document.querySelector('input[name="player-gender"][value="M"]').checked = false;
        document.querySelector('input[name="player-gender"][value="F"]').checked = false;
        $('player-skill').value = '3';
        const ac = $('player-active'); if (ac) ac.checked = true;
        showToast('Jogador adicionado!', 'success');
    }
    function upsertPlayer(name, gender, skill) {
        if (!name || !gender || !skill) return showToast('Preencha nome, sexo e habilidade.', 'error');
        if (STATE.editingId) {
            const idx = STATE.players.findIndex(p=>p.id===STATE.editingId);
            if (idx>=0) {
                const old = STATE.players[idx];
                const active = !!$('player-active')?.checked;
                STATE.players[idx] = { id: old.id, name: name.trim(), gender, skill: Number(skill), present: !!old.present, active: (typeof old.active==='boolean'?active:active), createdAt: old.createdAt || new Date().toISOString() };
            } else {
                const active = !!$('player-active')?.checked;
                STATE.players.push({ id: genId(), name: name.trim(), gender, skill: Number(skill), present: false, active, createdAt: new Date().toISOString() });
            }
            STATE.editingId = null;
            const addBtn = $('btn-add-player'); if (addBtn) addBtn.textContent = '➕ Adicionar';
            $('player-name').value = '';
            document.querySelector('input[name="player-gender"][value="M"]').checked = false;
            document.querySelector('input[name="player-gender"][value="F"]').checked = false;
            $('player-skill').value = '3';
            const ac = $('player-active'); if (ac) ac.checked = true;
            savePlayers();
            showToast('Jogador salvo!', 'success');
            // Após salvar, retornar à aba Jogadores para visualizar mudanças
            const navBtn = Array.from($$('.tab-link')).find(b => b.dataset.tab === 'jogadores');
            if (navBtn) navBtn.click();
        } else {
            addPlayer(name, gender, skill);
        }
    }
    $('btn-add-player')?.addEventListener('click', () => {
        const name = $('player-name').value;
        const gender = (document.querySelector('input[name="player-gender"]:checked')||{}).value;
        const skill = $('player-skill').value;
        upsertPlayer(name, gender, skill);
    });
    // =============================
    // LISTA E SELEÇÃO DE JOGADORES
    // =============================
    function renderPlayersList() {
        const root = $('players-list');
        if (!root) return;
        root.innerHTML = '';
        const q = (($('player-search')?.value)||'').trim().toLowerCase();
        const players = [...STATE.players]
            .filter(p=> STATE.showActiveOnly ? (p.active!==false) : true)
            .filter(p=>!q || p.name.toLowerCase().includes(q))
            .sort((a,b)=> a.name.localeCompare(b.name));
        const table = document.createElement('table');
        table.className = 'players-table';
        const thead = document.createElement('thead');
        const trh = document.createElement('tr');
        ['Nome','Sexo','Habilidade','Presente','Ações'].forEach(h=>{ const th=document.createElement('th'); th.textContent=h; trh.appendChild(th); });
        thead.appendChild(trh);
        const tbody = document.createElement('tbody');
        players.forEach(p=>{
            const tr = document.createElement('tr');
            const tdName = document.createElement('td'); tdName.textContent = p.name; tr.appendChild(tdName);
            const tdGender = document.createElement('td');
            const gSpan = document.createElement('span');
            gSpan.className = 'tag ' + (p.gender==='M' ? 'tag-m' : 'tag-f');
            gSpan.textContent = (p.gender==='M' ? 'M' : 'F');
            tdGender.appendChild(gSpan);
            tr.appendChild(tdGender);
            const tdSkill = document.createElement('td');
            const stars = '★'.repeat(Math.max(0, Math.min(5, Number(p.skill)||0))) + '☆'.repeat(Math.max(0, 5 - (Number(p.skill)||0)));
            const span = document.createElement('span'); span.className = 'stars'; span.textContent = stars; tdSkill.appendChild(span); tr.appendChild(tdSkill);
            const tdPresent = document.createElement('td');
            const chk = document.createElement('input'); chk.type='checkbox'; chk.checked=!!p.present; chk.title='Selecionar para o dia';
            chk.addEventListener('change', ()=>{ p.present = chk.checked; savePlayers(); });
            tdPresent.appendChild(chk); tr.appendChild(tdPresent);
            const tdActions = document.createElement('td'); tdActions.className = 'actions-cell';
            const btnEdit = document.createElement('button'); btnEdit.className='icon-btn'; btnEdit.title='Editar'; btnEdit.textContent='✏️';
            btnEdit.addEventListener('click', ()=>{
                // Preenche cadastro para edição e muda botão para salvar
                $('player-name').value = p.name;
                const rg = document.querySelector(`input[name="player-gender"][value="${p.gender}"]`);
                if (rg) rg.checked = true;
                $('player-skill').value = String(p.skill);
                const ac = $('player-active'); if (ac) ac.checked = (p.active!==false);
                STATE.editingId = p.id;
                const addBtn = $('btn-add-player'); if (addBtn) addBtn.textContent = '💾 Salvar';
                const navBtn = Array.from($$('.tab-link')).find(b => b.dataset.tab === 'cadastro');
                if (navBtn) navBtn.click();
            });
            tdActions.appendChild(btnEdit); tr.appendChild(tdActions);
            tbody.appendChild(tr);
        });
        table.appendChild(thead); table.appendChild(tbody);
        root.appendChild(table);
    }

    // Busca ativa por nome
    $('player-search')?.addEventListener('input', () => {
        renderPlayersList();
    });
    $('toggle-ativos')?.addEventListener('change', () => {
        STATE.showActiveOnly = !!$('toggle-ativos')?.checked;
        renderPlayersList();
    });
    // botão de ação em massa removido
    // Limpa seleção de presentes
    $('btn-clear-presentes')?.addEventListener('click', () => {
        STATE.players.forEach(p=>p.present=false);
        savePlayers();
        renderPlayersList();
    });

    // =========================================
    // CORE: SORTEIO BALANCEADO
    // =========================================
$('btn-sortear').addEventListener('click', async () => {
        // Usa jogadores presentes; se nenhum marcado, usa todos cadastrados como fallback
        let presentes = STATE.players.filter(p=>p.present);
        if (!presentes.length) presentes = [...STATE.players];
        const men = presentes.filter(p=>p.gender==='M').sort((a,b)=>b.skill-a.skill);
        const women = presentes.filter(p=>p.gender==='F').sort((a,b)=>b.skill-a.skill);

        STATE.teams = [];
        let teamId = 1;
        const numFullTeams = Math.floor(presentes.length / CONFIG.TEAM_SIZE);
        // Se não há times completos possíveis, tudo vai para reserva
        if (numFullTeams <= 0) {
            const color = CONFIG.COLORS[(teamId-1) % CONFIG.COLORS.length];
            const type = presentes.length >= 3 ? 'revezamento' : 'reserva';
            STATE.teams.push({ name: `Reserva`, color: color.n, hex: color.c, type, players: presentes });
            updateUI();
            saveSessionField('teams', STATE.teams);
            if (SUPABASE.online) { saveSessionFieldRemote('teams', STATE.teams).catch(()=>{}); }
            $$('.tab-link')[2].click();
            return;
        }
        const teamsBuckets = Array.from({length: numFullTeams}, ()=>({list:[], mTarget:0, fTarget:0}));
        const preferMen = Math.floor(CONFIG.TEAM_SIZE / 2);
        const preferWomen = CONFIG.TEAM_SIZE - preferMen;
        const menToUse = Math.min(men.length, numFullTeams * CONFIG.TEAM_SIZE);
        const baseMen = Math.min(preferMen, Math.floor(menToUse / numFullTeams));
        let remainderMen = Math.min(menToUse % numFullTeams, numFullTeams);
        teamsBuckets.forEach((tb, i) => { tb.mTarget = Math.min(baseMen + (i < remainderMen ? 1 : 0), preferMen); });
        const idealWomenTotal = Math.min(women.length, numFullTeams * CONFIG.TEAM_SIZE - teamsBuckets.reduce((s,t)=>s+t.mTarget,0));
        const baseWomen = Math.floor(idealWomenTotal / numFullTeams);
        let remainderWomen = idealWomenTotal % numFullTeams;
        teamsBuckets.forEach((tb, i) => { tb.fTarget = Math.min(baseWomen + (i < remainderWomen ? 1 : 0), preferWomen); });

        // Helpers para medir o equilíbrio por habilidade
        const teamSkill = (tb) => tb.list.reduce((s,p)=>s+(p.skill||0), 0);
        const countM = (tb) => tb.list.filter(x=>x.gender==='M').length;
        const countF = (tb) => tb.list.filter(x=>x.gender==='F').length;

        // Round-robin em rodadas (snake) para homens e mulheres
        const reserve = [];
        let dir = 1; let mIdx = 0;
        while (mIdx < men.length) {
            const chunk = men.slice(mIdx, mIdx + numFullTeams);
            if (!chunk.length) break;
            const order = dir === 1 ? chunk : [...chunk].reverse();
            order.forEach((p, k) => {
                let tries = 0; let ti = k;
                while (tries < teamsBuckets.length && (countM(teamsBuckets[ti]) >= teamsBuckets[ti].mTarget || teamsBuckets[ti].list.length >= CONFIG.TEAM_SIZE)) { ti = (ti + 1) % teamsBuckets.length; tries++; }
                if (tries < teamsBuckets.length) teamsBuckets[ti].list.push(p); else reserve.push(p);
            });
            mIdx += chunk.length; dir *= -1;
        }
        dir = 1; let wIdx = 0;
        while (wIdx < women.length) {
            const chunk = women.slice(wIdx, wIdx + numFullTeams);
            if (!chunk.length) break;
            const order = dir === 1 ? chunk : [...chunk].reverse();
            order.forEach((p, k) => {
                let tries = 0; let ti = k;
                while (tries < teamsBuckets.length && (countF(teamsBuckets[ti]) >= teamsBuckets[ti].fTarget || teamsBuckets[ti].list.length >= CONFIG.TEAM_SIZE)) { ti = (ti + 1) % teamsBuckets.length; tries++; }
                if (tries < teamsBuckets.length) teamsBuckets[ti].list.push(p); else reserve.push(p);
            });
            wIdx += chunk.length; dir *= -1;
        }

        // Completar times com reserva mantendo equilíbrio de habilidade por rodada
        let remaining = reserve.concat(men.slice(mIdx)).concat(women.slice(wIdx));
        remaining.sort((a,b)=>b.skill-a.skill);
        dir = 1;
        while (teamsBuckets.some(tb => tb.list.length < CONFIG.TEAM_SIZE) && remaining.length) {
            const chunk = remaining.slice(0, numFullTeams);
            const order = dir === 1 ? chunk : [...chunk].reverse();
            order.forEach((p) => {
                const candidates = teamsBuckets.filter(tb => tb.list.length < CONFIG.TEAM_SIZE);
                if (!candidates.length) return;
                const alvo = candidates.sort((a,b)=>{
                    const sa = teamSkill(a), sb = teamSkill(b);
                    if (sa !== sb) return sa - sb;
                    return a.list.length - b.list.length;
                })[0];
                alvo.list.push(p);
            });
            remaining = remaining.slice(chunk.length);
            dir *= -1;
        }
        // Cria times completos
        teamsBuckets.forEach(tb => {
            const color = CONFIG.COLORS[(teamId-1) % CONFIG.COLORS.length];
            const players = tb.list.slice(0, CONFIG.TEAM_SIZE);
            const type = players.length === CONFIG.TEAM_SIZE ? 'completo' : (players.length>=3 ? 'revezamento' : 'reserva');
            STATE.teams.push({ name: `${teamId} - ${color.n}`, color: color.n, hex: color.c, type, players: players });
            teamId++;
        });
        // Reserva final
        const extraLeftovers = remaining.concat(...teamsBuckets.map(tb=>tb.list.slice(CONFIG.TEAM_SIZE)));
        if (extraLeftovers.length) {
            const type = extraLeftovers.length >= 3 ? 'revezamento' : 'reserva';
            const color = CONFIG.COLORS[(teamId-1) % CONFIG.COLORS.length];
            STATE.teams.push({ name: `Reserva`, color: color.n, hex: color.c, type, players: extraLeftovers });
        }

        updateUI();
        // Persistir times do dia
        saveSessionField('teams', STATE.teams);
        if (SUPABASE.online) { saveSessionFieldRemote('teams', STATE.teams).catch(()=>{}); }
        // Navega para a aba de Times para exibir os sorteados
        const navBtn = Array.from($$('.tab-link')).find(b => b.dataset.tab === 'times');
        if (navBtn) navBtn.click();
    });

    function createTeam(id, players, type) {
        const color = CONFIG.COLORS[(id-1) % CONFIG.COLORS.length];
        return {
            name: `${id} - ${color.n}`,
            color: color.n,
            hex: color.c,
            type: type,
            players: shuffle(players)
        };
    }

    // =========================================
    // UI UPDATE
    // =========================================
    function updateUI() {
        // Renderiza Times
        const out = $('teams-output');
        out.innerHTML = '';
        STATE.teams.forEach(t => {
            let note = t.type === 'completo' ? 'Cede jogadores na pausa' :
                       t.type === 'revezamento' ? `Recebe ${CONFIG.TEAM_SIZE - t.players.length} jogador(es)` :
                       'Aguardam próxima rodada';
            
            out.innerHTML += `
            <div class="team-card" style="--team-c: ${t.hex}">
                <h3>${t.name}</h3>
                <ul>
                    ${t.players.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(p => `
                        <li>
                            <span>${p.name}</span>
                            <span class="tag tag-${p.gender.toLowerCase()}">${p.gender}</span>
                            <button class="btn-green" data-action="substitute" data-team="${t.name}" data-player="${p.name}" style="margin:0; padding:4px 8px; width:auto">⇄ Substituir</button>
                        </li>
                    `).join('')}
                </ul>
                <div class="team-info">${note}</div>
            </div>`;
        });

        // Gera Partidas com restrições
        generateSchedule();

        // Popular seletores manuais
        populateManualSelectors();

        // Eventos de substituição
        document.querySelectorAll('[data-action="substitute"]').forEach(btn => {
            btn.addEventListener('click', () => {
                const teamName = btn.dataset.team;
                const playerName = btn.dataset.player;
                suggestAndSwap(teamName, playerName);
            });
        });
    }

    function generateSchedule() {
        STATE.matches = [];
        const playTeams = STATE.teams.filter(t => t.type !== 'reserva');
        const list = $('match-list');
        const sel = $('match-selector');
        list.innerHTML = '';
        sel.innerHTML = '<option value="">-- Selecione --</option>';
        if (playTeams.length < 2) return;

        // Alvo: 3 jogos por time; intercalar para não passar de 2 seguidos
        const targetPerTeam = 3;
        const played = new Map(playTeams.map(t=>[t.name,0]));
        const consec = new Map(playTeams.map(t=>[t.name,0]));

        // pares únicos base
        let basePairs = [];
        for (let i=0;i<playTeams.length;i++) {
            for (let j=i+1;j<playTeams.length;j++) {
                basePairs.push([playTeams[i], playTeams[j]]);
            }
        }
        // Se necessário, duplica pares para atingir a meta de jogos
        const totalNeeded = Math.ceil((playTeams.length * targetPerTeam) / 2);
        let pairs = [...basePairs];
        let k = 0;
        while (pairs.length < totalNeeded) {
            pairs.push(basePairs[k % basePairs.length]);
            k++;
        }

        const schedule = [];
        // Greedy: escolhe próximo par que respeita limites e ainda precisa jogar
        while (schedule.length < totalNeeded && pairs.length) {
            let idx = pairs.findIndex(([a,b]) => {
                const aName = a.name, bName = b.name;
                if (played.get(aName) >= targetPerTeam || played.get(bName) >= targetPerTeam) return false;
                if (consec.get(aName) >= 2 || consec.get(bName) >= 2) return false;
                return true;
            });
            if (idx === -1) {
                // relaxa restrição consecutiva se travar
                idx = pairs.findIndex(([a,b]) => played.get(a.name) < targetPerTeam && played.get(b.name) < targetPerTeam);
                if (idx === -1) break;
            }
            const [a,b] = pairs.splice(idx,1)[0];
            schedule.push([a.name, b.name]);
            // atualiza contagens
            playTeams.forEach(t=>{
                const nm = t.name;
                const isPlaying = (nm===a.name || nm===b.name);
                consec.set(nm, isPlaying ? consec.get(nm)+1 : 0);
                played.set(nm, played.get(nm) + (isPlaying ? 1 : 0));
            });
        }

        STATE.matches = schedule;
        // Persistir jogos do dia
        saveSessionField('matches', STATE.matches);
        if (SUPABASE.online) { saveSessionFieldRemote('matches', STATE.matches).catch(()=>{}); }

        // Render
        schedule.forEach(([na, nb]) => {
            const ta = playTeams.find(t=>t.name===na);
            const tb = playTeams.find(t=>t.name===nb);
            list.innerHTML += `<li style="border-color:${ta.hex}">
                <span style="color:${ta.hex}">${na}</span> vs 
                <span style="color:${tb.hex}">${nb}</span>
            </li>`;
            sel.innerHTML += `<option value="${na}|${nb}">${na} vs ${nb}</option>`;
        });
    }

    // =========================================
    // PLACAR
    // =========================================
    $('btn-start-match').addEventListener('click', () => {
        const val = $('match-selector').value;
        if(!val) return alert('Selecione uma partida!');
        const [na, nb] = val.split('|');
        const ta = STATE.teams.find(t=>t.name===na);
        const tb = STATE.teams.find(t=>t.name===nb);

        $('team-a-name').textContent = ta.name; $('team-a-name').style.color = ta.hex;
        $('team-b-name').textContent = tb.name; $('team-b-name').style.color = tb.hex;
        
        STATE.score = {a:0, b:0};
        updateScore();
        STATE.currentMatchTeams = [ta.name, tb.name];
        setMatchState('playing');
        if (!$('placar').classList.contains('active')) $$('.tab-link')[3].click();
    });

    $$('.btn-score').forEach(btn => btn.addEventListener('click', e => {
        if (!STATE.matchActive) return;
        STATE.score[e.target.dataset.team]++;
        updateScore();
        if (STATE.score.a >= CONFIG.WIN_SCORE || STATE.score.b >= CONFIG.WIN_SCORE) {
            setMatchState('finished');
            showToast('Fim de jogo! Clique em "Finalizar".', 'info', 3500);
        }
    }));
    $$('.btn-score-minus').forEach(btn => btn.addEventListener('click', e => {
        if (!STATE.matchActive) return;
        const k = e.target.dataset.team;
        STATE.score[k] = Math.max(0, STATE.score[k]-1);
        updateScore();
    }));

    $('btn-finish-match').addEventListener('click', () => {
        if (STATE.score.a === 0 && STATE.score.b === 0) return alert('Placar zerado!');
        const res = `[${new Date().toLocaleTimeString()}] ${$('team-a-name').textContent} (${STATE.score.a}) x (${STATE.score.b}) ${$('team-b-name').textContent}`;
        STATE.results.unshift(res);
        // salva linha detalhada em IndexedDB e Supabase
        const resultRow = {
            date: new Date().toISOString().split('T')[0],
            time: new Date().toLocaleTimeString(),
            teamA: $('team-a-name').textContent,
            teamB: $('team-b-name').textContent,
            scoreA: STATE.score.a,
            scoreB: STATE.score.b,
            winner: (STATE.score.a > STATE.score.b) ? $('team-a-name').textContent : $('team-b-name').textContent
        };
        try { if (DB.db) DB.add('results', resultRow).catch(()=>{}); } catch(e) {}
        (async ()=>{
            try {
                if (SUPABASE.online && SUPABASE.client) {
                    const { error } = await SUPABASE.client.from('results').insert([resultRow]);
                    if (error) console.warn('Supabase insert results error:', error);
                }
            } catch(e) { console.warn('Supabase insert results exception:', e); }
        })();
        // atualiza estatísticas
        const ta = $('team-a-name').textContent;
        const tb = $('team-b-name').textContent;
        bumpTeamStats(ta, tb, STATE.score);
        saveData();
        
        showToast('Resultado salvo!', 'success');
        setMatchState('idle');
        $('match-selector').querySelector(`option[value="${$('match-selector').value}"]`)
          ?.remove();
        $('match-selector').value = "";
        $('team-a-name').textContent = 'Time A'; $('team-a-name').style.color = '#fff';
        $('team-b-name').textContent = 'Time B'; $('team-b-name').style.color = '#fff';
        STATE.score = {a:0, b:0};
        STATE.currentMatchTeams = null;
        updateScore();
        try { renderResultsTable(); } catch(e) {}
    });

    $('btn-reset-score').addEventListener('click', () => {
        if(confirm('Zerar placar?')) {
            STATE.score = {a:0, b:0}; updateScore();
            if($('team-a-name').textContent !== 'Time A') setMatchState('playing');
        }
    });

    function setMatchState(st) {
        STATE.matchActive = (st === 'playing');
        $$('.btn-score').forEach(b => b.disabled = (st !== 'playing'));
        $$('.btn-score-minus').forEach(b => b.disabled = (st !== 'playing'));
        $('btn-finish-match').disabled = (st === 'idle');
    }
    function updateScore() {
        $('score-a').textContent = STATE.score.a;
        $('score-b').textContent = STATE.score.b;
    }

    // =========================================
    // UTILITÁRIOS
    // =========================================
    function saveData() {
        localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(STATE.results));
        // Persistir resultados e estatísticas
        saveSessionField('results', STATE.results);
        saveSessionField('teamStats', STATE.teamStats);
        if (SUPABASE.online) {
            try { saveSessionFieldRemote('results', STATE.results); } catch(e) {}
            try { saveSessionFieldRemote('teamStats', STATE.teamStats); } catch(e) {}
        }
        // Atualiza a tabela de histórico
        try { renderResultsTable(); } catch(e) {}
    }
    async function loadData() {
        const d = localStorage.getItem(CONFIG.STORAGE_KEY);
        if(d) STATE.results = JSON.parse(d);
        await loadSessionToday();
        if (SUPABASE.online) { try { await loadSessionTodayRemote(); } catch(e) {} }
        saveData();
    }
    // será chamado após abrir o DB mais abaixo

    function bumpTeamStats(na, nb, score) {
        [na, nb].forEach(n=>{
            if (!STATE.teamStats[n]) STATE.teamStats[n] = { played:0, wins:0 };
            STATE.teamStats[n].played++;
        });
        if (score.a > score.b) STATE.teamStats[na].wins++;
        else if (score.b > score.a) STATE.teamStats[nb].wins++;
    }

    async function copyText(text) {
        try { await navigator.clipboard.writeText(text); showToast('Copiado para a área de transferência.', 'success'); }
        catch (e) { 
            $('clipboard-helper').value = text; $('clipboard-helper').select();
            document.execCommand('copy'); showToast('Copiado (modo compatibilidade).', 'success');
        }
    }

    $('btn-copy-teams').onclick = () => copyText(STATE.teams.map(t => `[${t.name}]\n${t.players.map(p=>p.name).join(', ')}`).join('\n\n') || 'Nada para copiar.');
    $('btn-copy-matches').onclick = () => copyText(STATE.matches.map((m,i)=>`${i+1}. ${m[0]} x ${m[1]}`).join('\n') || 'Nada para copiar.');
    async function getResultsRows() {
        // Tenta obter registros detalhados do IndexedDB; se vazio, faz fallback em STATE.results
        let rows = [];
        try { if (DB.db) rows = await DB.getAll('results'); } catch(e) {}
        if (!rows || !rows.length) {
            rows = (STATE.results||[]).map(r => {
                const m = r.match(/^\[(.+?)\]\s(.+?)\s\((\d+)\)\sx\s\((\d+)\)\s(.+)$/);
                if (!m) return null;
                return { date: todayKey(), time: m[1], teamA: m[2], scoreA: Number(m[3]), scoreB: Number(m[4]), teamB: m[5], winner: (Number(m[3])>Number(m[4]))?m[2]:m[5] };
            }).filter(Boolean);
        }
        // filtros
        const f = STATE.resultsFilter;
        const dd = f.date || '';
        if (dd) rows = rows.filter(r => String(r.date) === dd);
        // ordena por hora, decrescente
        rows.sort((a,b)=>String(b.time).localeCompare(String(a.time)));
        return rows;
    }
    async function renderResultsTable() {
        const el = $('results-table'); if (!el) return;
        const tbody = el.querySelector('tbody'); if (!tbody) return;
        const rows = await getResultsRows();
        // paginação
        const pgSize = Number(STATE.resultsFilter.pageSize)||10;
        const total = rows.length;
        const totalPages = Math.max(1, Math.ceil(total / pgSize));
        STATE.resultsFilter.page = Math.min(Math.max(1, STATE.resultsFilter.page), totalPages);
        const start = (STATE.resultsFilter.page - 1) * pgSize;
        const pageRows = rows.slice(start, start + pgSize);
        tbody.innerHTML = pageRows.map(r => `<tr><td>${r.time}</td><td>${r.teamA}</td><td>${r.scoreA} x ${r.scoreB}</td><td>${r.teamB}</td><td>${r.winner}</td></tr>`).join('') || '<tr><td colspan="5" style="opacity:.7">(Sem resultados)</td></tr>';
        const pi = $('page-info'); if (pi) pi.textContent = `Página ${STATE.resultsFilter.page} de ${totalPages}`;
        const prev = $('page-prev'); const next = $('page-next');
        if (prev) prev.disabled = (STATE.resultsFilter.page <= 1);
        if (next) next.disabled = (STATE.resultsFilter.page >= totalPages);
        // seletor de times e campo de busca removidos conforme solicitado
    }

    async function getHistoryRows() {
        let rows = [];
        try { if (DB.db) rows = await DB.getAll('results'); } catch(e) {}
        if (!rows || !rows.length) {
            rows = (STATE.results||[]).map(r => {
                const m = r.match(/^\[(.+?)\]\s(.+?)\s\((\d+)\)\sx\s\((\d+)\)\s(.+)$/);
                if (!m) return null;
                return { date: todayKey(), time: m[1], teamA: m[2], scoreA: Number(m[3]), scoreB: Number(m[4]), teamB: m[5], winner: (Number(m[3])>Number(m[4]))?m[2]:m[5] };
            }).filter(Boolean);
        }
        const today = todayKey();
        rows = rows.filter(r => String(r.date) !== today);
        // ordena por data e hora, decrescente
        rows.sort((a,b)=>{
            const d = String(b.date).localeCompare(String(a.date));
            if (d!==0) return d;
            return String(b.time).localeCompare(String(a.time));
        });
        return rows;
    }

    async function renderHistoryTable() {
        const el = $('history-table'); if (!el) return;
        const tbody = el.querySelector('tbody'); if (!tbody) return;
        const rows = await getHistoryRows();
        const pgSize = Number(STATE.historyFilter.pageSize)||10;
        const total = rows.length;
        const totalPages = Math.max(1, Math.ceil(total / pgSize));
        STATE.historyFilter.page = Math.min(Math.max(1, STATE.historyFilter.page), totalPages);
        const start = (STATE.historyFilter.page - 1) * pgSize;
        const pageRows = rows.slice(start, start + pgSize);
        tbody.innerHTML = pageRows.map(r => `<tr><td>${r.date}</td><td>${r.time}</td><td>${r.teamA}</td><td>${r.scoreA} x ${r.scoreB}</td><td>${r.teamB}</td><td>${r.winner}</td></tr>`).join('') || '<tr><td colspan="6" style="opacity:.7">(Sem resultados anteriores)</td></tr>';
        const pi = $('history-page-info'); if (pi) pi.textContent = `Página ${STATE.historyFilter.page} de ${totalPages}`;
        const prev = $('history-page-prev'); const next = $('history-page-next');
        if (prev) prev.disabled = (STATE.historyFilter.page <= 1);
        if (next) next.disabled = (STATE.historyFilter.page >= totalPages);
    }
    $('btn-copy-results').onclick = async () => {
        const rows = await getResultsRows();
        const text = rows.map(r => `[${r.time}] ${r.teamA} (${r.scoreA}) x (${r.scoreB}) ${r.teamB}`).join('\n');
        copyText(text || '--- Histórico vazio ---');
    };
    $('btn-clear-results').onclick = async () => {
        if(!confirm('Apagar histórico?')) return;
        STATE.results = [];
        try { if (DB.db) await DB.clear('results'); } catch(e) {}
        saveData();
    };

    // Sincronização manual com Banco
    $('btn-sync-db')?.addEventListener('click', async () => {
        const rows = await getResultsRows();
        if (!rows.length) return showToast('Sem resultados para sincronizar.', 'info');
        if (!SUPABASE.online || !SUPABASE.client) return showToast('Banco offline. Configure o Supabase.', 'error');
        let ok = 0, fail = 0;
        for (const r of rows) {
            try {
                const { error } = await SUPABASE.client.from('results').insert([r]);
                if (error) { console.warn('Insert error:', error); fail++; }
                else ok++;
            } catch(e) { console.warn('Insert exception:', e); fail++; }
        }
        if (fail === 0) showToast(`Sincronização concluída: ${ok} registro(s) enviados.`, 'success');
        else showToast(`Sincronização concluída com erros. Sucesso: ${ok}, Falhas: ${fail}.`, 'error');
    });

    $('btn-download-pdf').onclick = async () => {
        if (!window.jspdf || (!STATE.teams.length && !STATE.results.length)) return showToast('Nada para gerar PDF.', 'info');
        const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
        const page = { w: 210, h: 297, margin: 10 };
        let y = page.margin;
        const checkY = (h=10) => { if(y+h>page.h - page.margin) { doc.addPage(); y=page.margin; }};

        const hexToRgb = (hex) => {
            const c = (hex||'#9e9e9e').replace('#','');
            const n = parseInt(c.length===3 ? c.split('').map(x=>x+x).join('') : c, 16);
            return { r: (n>>16)&255, g: (n>>8)&255, b: n&255 };
        };
        const contrastText = (hex) => {
            const {r,g,b} = hexToRgb(hex);
            const luminance = (0.299*r + 0.587*g + 0.114*b);
            return luminance > 140 ? {r:20,g:20,b:20} : {r:255,g:255,b:255};
        };
        const getTeamHex = (name) => {
            const t = STATE.teams.find(tt => tt.name === name);
            return t ? (t.hex||'#607d8b') : '#9e9e9e';
        };
        const divider = (topGap = 6, bottomGap = 5) => {
            // adiciona espaço antes e depois da linha para evitar cortar textos
            y += topGap;
            doc.setDrawColor(200);
            doc.setLineWidth(0.3);
            doc.line(page.margin, y, page.w - page.margin, y);
            y += bottomGap;
            doc.setDrawColor(0);
        };

        // Cabeçalho estilizado
        doc.setFillColor(18,18,30); doc.roundedRect(page.margin, y, page.w - page.margin*2, 20, 3, 3, 'F');
        doc.setTextColor(255); doc.setFontSize(14);
        doc.text(`Resultados finais - Vôlei - ${new Date().toLocaleString()}`, page.margin+5, y+12);
        y += 26;

        // Grid de Times Formados (3 colunas, espaçamento vertical 5)
        doc.setTextColor(30); doc.setFontSize(13); doc.text('Times Formados', page.margin, y); y += 6;
        const cols = 3; const hGap = 4; const vGap = 5;
        const cardW = (page.w - page.margin*2 - hGap*(cols-1)) / cols;
        let colIndex = 0; let currentRowMaxH = 0; let rowStartY = y;
        STATE.teams.forEach((t, idx) => {
            const cx = page.margin + colIndex * (cardW + hGap);
            const cy = rowStartY;
            const rgb = hexToRgb(t.hex||'#607d8b');
            doc.setDrawColor(rgb.r, rgb.g, rgb.b);
            // calcula altura dinâmica do card com jogadores linha a linha
            const titleH = 8; const lineH = 4; const pad = 4;
            const cardH = Math.max(12, pad + titleH + (t.players.length * lineH) + pad);
            checkY(cardH);
            doc.roundedRect(cx, cy, cardW, cardH, 2, 2, 'S');
            doc.setTextColor(30);
            doc.setFontSize(10); doc.text(`${t.name}`, cx+4, cy+6);
            doc.setFontSize(7);
            let py = cy + 10;
            t.players.slice().sort((a,b)=>a.name.localeCompare(b.name)).forEach(p => {
                const name = p.name; const sex = p.gender || '';
                doc.text(name, cx+4, py);
                const sexW = doc.getTextWidth(sex);
                doc.text(sex, cx + cardW - 4 - sexW, py);
                py += lineH;
            });
            currentRowMaxH = Math.max(currentRowMaxH, cardH);
            colIndex++;
            if (colIndex === cols) {
                rowStartY += currentRowMaxH + vGap;
                y = rowStartY;
                colIndex = 0;
                currentRowMaxH = 0;
            }
        });
        if (colIndex !== 0) { rowStartY += currentRowMaxH + vGap; y = rowStartY; }
        y += 2;
        divider();

        // Tabela de Partidas Jogadas (Todas)
        doc.setTextColor(30); doc.setFontSize(13); doc.text('Partidas Jogadas (Todas)', page.margin, y); y += 6;
        doc.setFillColor(235,235,235); doc.rect(page.margin, y, page.w - page.margin*2, 6, 'F');
        doc.setTextColor(0); doc.setFontSize(8);
        doc.text('Data', page.margin+2, y+4); doc.text('Hora', page.margin+22, y+4); doc.text('Time A', page.margin+38, y+4); doc.text('Placar', page.margin+92, y+4); doc.text('Time B', page.margin+112, y+4); doc.text('Vencedor', page.margin+160, y+4);
        // aumenta o espaço após header para não sobrepor primeira linha da tabela
        y += 9;
        let rowsAll = [];
        try { if (DB.db) rowsAll = await DB.getAll('results'); } catch(e) {}
        if (!rowsAll || !rowsAll.length) {
            const todayRows = await getResultsRows(); const histRows = await getHistoryRows();
            rowsAll = [...todayRows, ...histRows];
        }
        rowsAll.sort((a,b)=> String(b.date).localeCompare(String(a.date)) || String(b.time).localeCompare(String(a.time)) );
        if (rowsAll.length) {
            rowsAll.forEach(r => {
                checkY(7);
                doc.setFontSize(8);
                const aRgb = hexToRgb(getTeamHex(r.teamA)); const bRgb = hexToRgb(getTeamHex(r.teamB)); const wRgb = hexToRgb(getTeamHex(r.winner));
                doc.setTextColor(30); doc.text(`${r.date}`, page.margin+2, y);
                doc.setTextColor(30); doc.text(`${r.time}`, page.margin+22, y);
                doc.setTextColor(aRgb.r, aRgb.g, aRgb.b); doc.text(`${r.teamA}`, page.margin+38, y);
                doc.setTextColor(30); doc.text(`${r.scoreA} x ${r.scoreB}`, page.margin+92, y);
                doc.setTextColor(bRgb.r, bRgb.g, bRgb.b); doc.text(`${r.teamB}`, page.margin+112, y);
                doc.setTextColor(wRgb.r, wRgb.g, wRgb.b); doc.text(`${r.winner}`, page.margin+160, y);
                y += 6;
            });
        } else {
            doc.setTextColor(120); doc.text('(Sem partidas registradas)', page.margin+2, y);
            y += 8;
        }
        // separa visualmente da próxima seção com margem maior
        divider(8,6);

        // Pódio dos 3 melhores times (final da página)
        const neededH = 40;
        if (page.h - page.margin - y > neededH) {
            y = page.h - page.margin - neededH;
        } else {
            checkY(neededH);
        }
        doc.setTextColor(30); doc.setFontSize(13); doc.text('Pódio • Top 3', page.margin, y); y += 10;
        const stats = Object.entries(STATE.teamStats).map(([name, s]) => ({ name, played: s.played||0, wins: s.wins||0, hex: getTeamHex(name) }));
        stats.sort((a,b)=> b.wins - a.wins || b.played - a.played || a.name.localeCompare(b.name));
        const podium = stats.slice(0,3);
        const baseX = page.margin; const pad = 6; const w1 = 60, w2 = 55, w3 = 50; const h1 = 26, h2 = 22, h3 = 18;
        const medalColors = { '1º':'#FFD700', '2º':'#C0C0C0', '3º':'#CD7F32' };
        const drawBlock = (x, width, height, item, label) => {
            const rgb = hexToRgb(medalColors[label]||'#9e9e9e');
            doc.setFillColor(rgb.r, rgb.g, rgb.b);
            doc.roundedRect(x, y, width, height, 2, 2, 'F');
            doc.setTextColor(20); doc.setFontSize(11);
            doc.text(`${label} • ${item.name}`, x+4, y+8);
            doc.setFontSize(9);
            doc.text(`Vitórias: ${item.wins} • Jogos: ${item.played}`, x+4, y+15);
        };
        if (podium.length) {
            drawBlock(baseX, w2, h2, podium[1]||podium[0]||{name:'—',wins:0,played:0,hex:'#bdbdbd'}, '2º');
            drawBlock(baseX + w2 + pad, w1, h1, podium[0]||{name:'—',wins:0,played:0,hex:'#bdbdbd'}, '1º');
            drawBlock(baseX + w2 + pad + w1 + pad, w3, h3, podium[2]||{name:'—',wins:0,played:0,hex:'#bdbdbd'}, '3º');
            y += h1 + 10;
        } else {
            doc.setTextColor(120); doc.text('(Sem estatísticas para pódio)', page.margin, y);
            y += 8;
        }

        doc.save(`Volei_${new Date().toISOString().split('T')[0]}.pdf`);
        
        // Mantém comportamento atual de limpar TXT e resultados do dia
        localStorage.setItem(CONFIG.DAILY_TXT_KEY, '');
        STATE.results = [];
        saveData();
    };

    // Util: download
    function downloadText(filename, text) {
        const blob = new Blob([text||''], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; document.body.appendChild(a); a.click();
        document.body.removeChild(a); URL.revokeObjectURL(url);
    }

    // Inicializa
    (async () => {
        // auto-conectar Supabase somente a partir de arquivo de configuração
        const fileCfg = (window.SUPABASE_CONFIG||{});
        const cfgUrl = fileCfg.url || '';
        const cfgKey = fileCfg.key || '';
        if (cfgUrl && cfgKey) {
            await initSupabase(cfgUrl, cfgKey);
        } else {
            setSupabaseStatus('offline');
        }
        try { await DB.open(); } catch(e) {}
        await loadPlayers();
        await loadData();
        try { await renderResultsTable(); } catch(e) {}
        try { await renderHistoryTable(); } catch(e) {}
        // inicializa filtros
        const d = $('filter-date'); if (d) { d.value = todayKey(); STATE.resultsFilter.date = d.value; d.addEventListener('change', ()=>{ STATE.resultsFilter.date = d.value; STATE.resultsFilter.page = 1; }); }
        const ps = $('filter-page-size'); if (ps) { ps.addEventListener('change', ()=>{ STATE.resultsFilter.pageSize = Number(ps.value)||10; STATE.resultsFilter.page = 1; }); }
        const go = $('btn-apply-filters'); if (go) { go.addEventListener('click', ()=>{ renderResultsTable(); }); }
        const prev = $('page-prev'); if (prev) { prev.addEventListener('click', ()=>{ STATE.resultsFilter.page = Math.max(1, STATE.resultsFilter.page-1); renderResultsTable(); }); }
        const next = $('page-next'); if (next) { next.addEventListener('click', ()=>{ STATE.resultsFilter.page = STATE.resultsFilter.page+1; renderResultsTable(); }); }
        const hps = $('history-page-size'); if (hps) { hps.addEventListener('change', ()=>{ STATE.historyFilter.pageSize = Number(hps.value)||10; STATE.historyFilter.page = 1; renderHistoryTable(); }); }
        const hprev = $('history-page-prev'); if (hprev) { hprev.addEventListener('click', ()=>{ STATE.historyFilter.page = Math.max(1, STATE.historyFilter.page-1); renderHistoryTable(); }); }
        const hnext = $('history-page-next'); if (hnext) { hnext.addEventListener('click', ()=>{ STATE.historyFilter.page = STATE.historyFilter.page+1; renderHistoryTable(); }); }
    })();

    // =============================
    // EXTRA: Seleção manual
    // =============================
    function populateManualSelectors() {
        const teams = STATE.teams.filter(t=>t.type!=='reserva');
        const a = $('manual-team-a'); const b = $('manual-team-b');
        if (!a || !b) return;
        a.innerHTML = '<option value="">Time A (extra)</option>';
        b.innerHTML = '<option value="">Time B (extra)</option>';
        teams.forEach(t=>{
            const optA = document.createElement('option'); optA.value = t.name; optA.textContent = t.name; a.appendChild(optA);
            const optB = document.createElement('option'); optB.value = t.name; optB.textContent = t.name; b.appendChild(optB);
        });
    }
    $('btn-start-extra')?.addEventListener('click', () => {
        const na = $('manual-team-a').value; const nb = $('manual-team-b').value;
        if(!na || !nb || na===nb) return showToast('Selecione dois times diferentes.', 'error');
        const ta = STATE.teams.find(t=>t.name===na);
        const tb = STATE.teams.find(t=>t.name===nb);
        $('team-a-name').textContent = ta.name; $('team-a-name').style.color = ta.hex;
        $('team-b-name').textContent = tb.name; $('team-b-name').style.color = tb.hex;
        STATE.score = {a:0, b:0}; updateScore();
        STATE.currentMatchTeams = [ta.name, tb.name];
        setMatchState('playing');
        if (!$('placar').classList.contains('active')) $$('.tab-link')[3].click();
    });

    // =============================
    // Substituição sugerida
    // =============================
    function getTeamByPlayer(name) {
        return STATE.teams.find(t=>t.players.some(p=>p.name===name));
    }
    function suggestCandidate(currentPlayer, excludeTeams=[]) {
        const hasPresent = STATE.players.some(p=>p.present);
        const pool = (hasPresent ? STATE.players.filter(p=>p.present && p.name!==currentPlayer.name) : STATE.players.filter(p=>p.name!==currentPlayer.name));
        const notPlaying = pool.filter(p=>{
            const team = getTeamByPlayer(p.name);
            if (!team) return true;
            return !excludeTeams.includes(team.name);
        });
        const sameSex = notPlaying.filter(p=>p.gender===currentPlayer.gender);
        let candidates = sameSex.filter(p=>Math.abs(p.skill - currentPlayer.skill) <= 1);
        if (!candidates.length) {
            candidates = sameSex.sort((a,b)=>Math.abs(a.skill-currentPlayer.skill)-Math.abs(b.skill-currentPlayer.skill));
        }
        if (!candidates.length) {
            candidates = notPlaying.sort((a,b)=>Math.abs(a.skill-currentPlayer.skill)-Math.abs(b.skill-currentPlayer.skill));
        }
        return candidates[0] || null;
    }
    function suggestAndSwap(teamName, playerName) {
        const team = STATE.teams.find(t=>t.name===teamName);
        if (!team) return;
        const player = team.players.find(p=>p.name===playerName);
        if (!player) return;
        const exclude = STATE.currentMatchTeams || [];
        const candidate = suggestCandidate(player, exclude);
        if (!candidate) return showToast('Nenhum substituto adequado encontrado.', 'info');
        const candTeam = getTeamByPlayer(candidate.name);
        const msg = `Substituir ${player.name} por ${candidate.name} (Sexo: ${candidate.gender}, Hab: ${candidate.skill})?`;
        if (!confirm(msg)) return;
        if (candTeam) {
            // Swap entre times
            candTeam.players = candTeam.players.filter(p=>p.name!==candidate.name);
            candTeam.players.push(player);
        }
        team.players = team.players.filter(p=>p.name!==player.name);
        team.players.push(candidate);
        updateUI();
    }
});