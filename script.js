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
        showInactiveOnly: false
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

    // Cards da aba Início que abrem outras telas
    $$('.home-card').forEach(card => {
        card.addEventListener('click', () => {
            const target = card.dataset.tabTarget;
            const navBtn = Array.from($$('.tab-link')).find(b => b.dataset.tab === target);
            if (navBtn) navBtn.click();
        });
    });

    // =========================================
    // IndexedDB: banco local
    // =========================================
    const DB = {
        db: null,
        open() {
            return new Promise((resolve, reject) => {
                const req = indexedDB.open('volei_db', 2);
                req.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    try { if (db.objectStoreNames.contains('players')) db.deleteObjectStore('players'); } catch(err) {}
                    db.createObjectStore('players', { keyPath: 'id' });
                    if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'date' });
                };
                req.onsuccess = () => { DB.db = req.result; resolve(DB.db); };
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
                alert('Falha ao conectar ao Supabase. Verifique URL/anon key e se as tabelas existem.');
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
                alert(`Coluna '${m[1]}' ausente em 'players'.\nExecute no Supabase Studio (SQL):\n\n${fix}`);
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
                alert(`A coluna '${m[1]}' não existe na tabela 'sessions'.\nExecute no Supabase Studio (SQL):\n\nALTER TABLE public.sessions ADD COLUMN IF NOT EXISTS ${m[1]} jsonb;`);
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
        if (!name || !gender || !skill) return alert('Preencha nome, sexo e habilidade.');
        const active = !!$('player-active')?.checked;
        STATE.players.push({ id: genId(), name: name.trim(), gender, skill: Number(skill), present: false, active, createdAt: new Date().toISOString() });
        savePlayers();
        $('player-name').value = '';
        document.querySelector('input[name="player-gender"][value="M"]').checked = false;
        document.querySelector('input[name="player-gender"][value="F"]').checked = false;
        $('player-skill').value = '3';
        const ac = $('player-active'); if (ac) ac.checked = true;
        alert('Jogador adicionado!');
    }
    function upsertPlayer(name, gender, skill) {
        if (!name || !gender || !skill) return alert('Preencha nome, sexo e habilidade.');
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
            alert('Jogador salvo!');
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
            .filter(p=> STATE.showInactiveOnly ? (p.active===false) : (p.active!==false))
            .filter(p=>!q || p.name.toLowerCase().includes(q))
            .sort((a,b)=>{
                const g = a.gender.localeCompare(b.gender);
                if (g!==0) return g;
                const s = b.skill - a.skill; if (s!==0) return s;
                return a.name.localeCompare(b.name);
            });
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
            const tdGender = document.createElement('td'); tdGender.textContent = (p.gender==='M'?'Masculino':'Feminino'); tr.appendChild(tdGender);
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
    $('toggle-inativos')?.addEventListener('change', () => {
        STATE.showInactiveOnly = !!$('toggle-inativos')?.checked;
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
        $$('.tab-link')[2].click(); // Vai para aba Times (ajustado por novas abas)
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
                    ${t.players.map(p => `
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

        // Duplo round-robin para garantir >=2 jogos
        const pairs = [];
        for(let rr=0; rr<2; rr++) {
            for(let i=0; i<playTeams.length; i++) {
                for(let j=i+1; j<playTeams.length; j++) {
                    pairs.push([playTeams[i], playTeams[j]]);
                }
            }
        }
        // Reordena para evitar >2 seguidas
        const schedule = [];
        const consec = new Map(playTeams.map(t=>[t.name,0]));
        const played = new Map(playTeams.map(t=>[t.name,0]));
        while (pairs.length) {
            let idx = pairs.findIndex(([a,b]) => consec.get(a.name) < 2 && consec.get(b.name) < 2);
            if (idx === -1) idx = 0;
            const [a,b] = pairs.splice(idx,1)[0];
            schedule.push([a.name, b.name]);
            // atualiza consecutivos
            playTeams.forEach(t=>consec.set(t.name, t.name===a.name||t.name===b.name ? consec.get(t.name)+1 : 0));
            playTeams.forEach(t=>played.set(t.name, played.get(t.name) + (t.name===a.name||t.name===b.name ? 1 : 0)));
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
            alert('Fim de jogo! Clique em Finalizar.');
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
        // atualiza estatísticas
        const ta = $('team-a-name').textContent;
        const tb = $('team-b-name').textContent;
        bumpTeamStats(ta, tb, STATE.score);
        saveData();
        
        alert('Salvo!');
        setMatchState('idle');
        $('match-selector').querySelector(`option[value="${$('match-selector').value}"]`)
          ?.remove();
        $('match-selector').value = "";
        $('team-a-name').textContent = 'Time A'; $('team-a-name').style.color = '#fff';
        $('team-b-name').textContent = 'Time B'; $('team-b-name').style.color = '#fff';
        STATE.score = {a:0, b:0};
        STATE.currentMatchTeams = null;
        updateScore();
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
        $('results-log').value = STATE.results.join('\n') || '--- Histórico vazio ---';
        // Persistir resultados e estatísticas
        saveSessionField('results', STATE.results);
        saveSessionField('teamStats', STATE.teamStats);
        if (SUPABASE.online) {
            try { saveSessionFieldRemote('results', STATE.results); } catch(e) {}
            try { saveSessionFieldRemote('teamStats', STATE.teamStats); } catch(e) {}
        }
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
        try { await navigator.clipboard.writeText(text); alert('Copiado!'); }
        catch (e) { 
            $('clipboard-helper').value = text; $('clipboard-helper').select();
            document.execCommand('copy'); alert('Copiado (modo manual)!');
        }
    }

    $('btn-copy-teams').onclick = () => copyText(STATE.teams.map(t => `[${t.name}]\n${t.players.map(p=>p.name).join(', ')}`).join('\n\n') || 'Nada para copiar.');
    $('btn-copy-matches').onclick = () => copyText(STATE.matches.map((m,i)=>`${i+1}. ${m[0]} x ${m[1]}`).join('\n') || 'Nada para copiar.');
    $('btn-copy-results').onclick = () => copyText($('results-log').value);
    $('btn-clear-results').onclick = () => { if(confirm('Apagar tudo?')) { STATE.results=[]; saveData(); }};

    $('btn-download-pdf').onclick = () => {
        if (!window.jspdf || (!STATE.teams.length && !STATE.results.length)) return alert('Nada para gerar PDF.');
        const doc = new window.jspdf.jsPDF();
        let y = 20;
        const checkY = (h=10) => { if(y+h>280) { doc.addPage(); y=20; }};
        
        doc.setFontSize(18); doc.text('Resumo do Vôlei', 10, y); y+=10;
        doc.setFontSize(10); doc.setTextColor(100); doc.text(new Date().toLocaleString(), 10, y); y+=15;
        
        doc.setTextColor(0); doc.setFontSize(14); doc.text('Times:', 10, y); y+=8;
        doc.setFontSize(11);
        STATE.teams.forEach(t => {
            checkY(20);
            doc.setTextColor(t.hex); doc.text(`• ${t.name} (${t.color})`, 10, y); y+=6;
            doc.setTextColor(60);
            const pList = t.players.map(p => `${p.name} (${p.gender})`).join(', ');
            const lines = doc.splitTextToSize(pList, 180);
            doc.text(lines, 15, y); y += (lines.length*5)+4;
        });

        checkY(30); y+=10;
        doc.setTextColor(0); doc.setFontSize(14); doc.text('Resultados:', 10, y); y+=8;
        doc.setFontSize(10);
        if(STATE.results.length) STATE.results.forEach(r => { checkY(6); doc.text(r, 10, y); y+=6; });
        else { doc.setTextColor(150); doc.text('(Sem resultados)', 10, y); }

        // Estatísticas por time e pódio
        checkY(20); y+=10;
        doc.setTextColor(0); doc.setFontSize(14); doc.text('Estatísticas:', 10, y); y+=8;
        doc.setFontSize(10);
        const statsEntries = Object.entries(STATE.teamStats);
        statsEntries.forEach(([name, st]) => { checkY(6); doc.text(`${name}: ${st.played} jogos, ${st.wins} vitórias`, 10, y); y+=6; });
        checkY(20); y+=10;
        doc.setTextColor(0); doc.setFontSize(14); doc.text('Pódio:', 10, y); y+=8;
        const podium = statsEntries.sort((a,b)=>b[1].wins-a[1].wins);
        doc.setFontSize(10);
        podium.forEach(([name, st], i) => { checkY(6); doc.text(`${i+1}. ${name} - ${st.wins} vitórias`, 10, y); y+=6; });

        doc.save(`Volei_${new Date().toISOString().split('T')[0]}.pdf`);

        // Limpa TXT e resultados do dia após imprimir
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
        if(!na || !nb || na===nb) return alert('Selecione dois times diferentes.');
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
        if (!candidate) return alert('Nenhum substituto adequado encontrado.');
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
