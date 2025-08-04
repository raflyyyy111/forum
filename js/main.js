document.addEventListener('DOMContentLoaded', () => {
    // === Konfigurasi & Seleksi Elemen DOM ===
    // PERBAIKAN: Daftar signaling server untuk dicoba secara berurutan
    const SIGNALING_SERVERS = [
        'wss://safe-salty-sand.glitch.me/',
        'wss://simple-peer-server-v2.glitch.me',
        'wss://webrtc-signal-server.glitch.me'
    ];
    const STUN_SERVER = 'stun:stun.l.google.com:19302';

    // Seleksi Elemen DOM
    const screens = { main: document.getElementById('main-screen'), chat: document.getElementById('chat-screen') };
    const creatorView = document.getElementById('creator-view');
    const joinerView = document.getElementById('joiner-view');
    const invitationView = document.getElementById('invitation-view');
    const createRoomButton = document.getElementById('create-room-button');
    const statusText = document.getElementById('status-text');
    const creatorStatusText = document.getElementById('creator-status-text');
    const inviteLinkOutput = document.getElementById('invite-link-output');
    const copyLinkButton = document.getElementById('copy-link-button');
    const messageInput = document.getElementById('message-input');
    const chatLog = document.getElementById('chat-log');
    const chatPrefix = document.querySelector('#chat-screen .cursor-prefix');
    const connectionStatus = document.getElementById('connection-status');
    const typingIndicator = document.getElementById('typing-indicator');

    // State Aplikasi
    let cryptoKey = null, roomId = null, peerConnection, dataChannel, ws, nickname = 'anon';
    let typingTimeout;

    // === Inisialisasi & Alur Utama ===
    async function init() {
        if (window.location.hash) {
            creatorView.style.display = 'none'; joinerView.style.display = 'block';
            try {
                const hashContent = window.location.hash.substring(1);
                const [parsedRoomId, keyString] = hashContent.split(':');
                if (!parsedRoomId || !keyString) throw new Error('Link undangan tidak valid.');
                roomId = parsedRoomId;
                updateStatus('Kunci terdeteksi. Mengimpor kunci enkripsi...');
                cryptoKey = await importKeyFromString(keyString);
                connectToSignalingServer();
            } catch (error) { updateStatus(`ERROR: ${error.message}`); }
        } else {
            creatorView.style.display = 'block'; joinerView.style.display = 'none';
        }
    }

    function showScreen(screenName) {
        Object.values(screens).forEach(screen => screen.classList.remove('active'));
        screens[screenName].classList.add('active');
    }

    function updateStatus(message, isCreator = false) {
        (isCreator ? creatorStatusText : statusText).textContent = `> ${message}`;
    }
    
    // === Logika Kriptografi (Tidak Berubah) ===
    async function createNewKey() { return await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']); }
    async function exportKeyToString(key) { const jwk = await crypto.subtle.exportKey('jwk', key); return btoa(JSON.stringify(jwk)); }
    async function importKeyFromString(keyString) { const jwk = JSON.parse(atob(keyString)); return await crypto.subtle.importKey('jwk', jwk, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']); }
    async function encryptMessage(key, plainText) { /* ... Kode sama persis dari jawaban sebelumnya ... */ const encoder=new TextEncoder(),encodedText=encoder.encode(plainText),iv=window.crypto.getRandomValues(new Uint8Array(12)),encryptedData=await crypto.subtle.encrypt({name:"AES-GCM",iv:iv},key,encodedText),ivB64=btoa(String.fromCharCode.apply(null,iv)),cipherB64=btoa(String.fromCharCode.apply(null,new Uint8Array(encryptedData)));return JSON.stringify({iv:ivB64,ciphertext:cipherB64}) }
    async function decryptMessage(key, encryptedPayload) { try{ const {iv:ivB64,ciphertext:cipherB64}=JSON.parse(encryptedPayload),iv=new Uint8Array(atob(ivB64).split("").map(c=>c.charCodeAt(0))),ciphertext=new Uint8Array(atob(cipherB64).split("").map(c=>c.charCodeAt(0))),decryptedBuffer=await crypto.subtle.decrypt({name:"AES-GCM",iv:iv},key,ciphertext),decoder=new TextDecoder();return decoder.decode(decryptedBuffer) } catch(error){ console.error("Decryption failed:",error);return"[[ PESAN GAGAL DIDEKRIPSI ]]" }}

    // === PERBAIKAN: Logika Koneksi ke Signaling Server ===
    function connectToSignalingServer(isCreator = false, serverIndex = 0) {
        if (serverIndex >= SIGNALING_SERVERS.length) {
            updateStatus('ERROR: Semua signaling server gagal merespon.', isCreator);
            return;
        }
        const serverUrl = SIGNALING_SERVERS[serverIndex];
        updateStatus(`Mencoba terhubung ke server ${serverIndex + 1}...`, isCreator);
        ws = new WebSocket(serverUrl);
        
        ws.onopen = () => { updateStatus(`Terhubung ke server ${serverIndex + 1}. Bergabung ke room...`, isCreator); ws.send(JSON.stringify({ type: 'join', roomId: roomId })); };
        ws.onerror = (error) => { console.error(`WebSocket Error on ${serverUrl}:`, error); ws.close(); };
        ws.onclose = () => { connectToSignalingServer(isCreator, serverIndex + 1); }; // Coba server berikutnya jika gagal
        ws.onmessage = async (event) => {
            ws.onclose = null; // Hentikan percobaan rekoneksi jika sudah dapat pesan
            const message = JSON.parse(event.data);
            switch (message.type) {
                case 'peer-joined': updateStatus('Teman terdeteksi! Memulai negosiasi...', true); await createOffer(); break;
                case 'offer': updateStatus('Menerima penawaran, membalas...'); await handleOffer(message.offer); break;
                case 'answer': updateStatus('Jawaban diterima, menyelesaikan koneksi...', true); await handleAnswer(message.answer); break;
                case 'ice-candidate': if (peerConnection) await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate)); break;
                case 'room-created': updateStatus('Room berhasil dibuat. Menunggu teman...', true); break;
                case 'room-joined': updateStatus('Berhasil gabung ke room. Menunggu teman...'); break;
                case 'room-full': updateStatus('ERROR: Room sudah penuh.'); ws.close(); break;
            }
        };
    }

    // === Logika WebRTC (Tidak Berubah) & Penambahan Status ===
    function setupPeerConnection() {
        peerConnection = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });
        peerConnection.onicecandidate = (event) => { if (event.candidate) ws.send(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate, roomId: roomId })); };
        peerConnection.ondatachannel = (event) => { dataChannel = event.channel; setupDataChannelEvents(); };
        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection.connectionState;
            connectionStatus.textContent = `Koneksi: ${state}`;
            if (state === 'connected') {
                connectionStatus.style.color = 'var(--text-primary)';
                setTimeout(() => { showScreen('chat'); promptForNickname(); }, 500);
            } else if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                connectionStatus.style.color = 'var(--accent-warning)';
                messageInput.disabled = true;
                if (ws && ws.readyState === WebSocket.OPEN) ws.close();
            }
        };
    }
    
    // === FITUR BARU: Penanganan Data Channel & Nickname ===
    function setupDataChannelEvents() {
        dataChannel.onopen = () => displayMessage('system', '-- Sesi Aman Aktif. --');
        dataChannel.onclose = () => displayMessage('system', '-- Teman terputus. Sesi berakhir. --');
        dataChannel.onmessage = async (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.type === 'typing') { // FITUR BARU: Indikator Mengetik
                    typingIndicator.textContent = `peer is typing...`;
                    clearTimeout(typingTimeout);
                    typingTimeout = setTimeout(() => { typingIndicator.textContent = ''; }, 2000);
                } else if (data.type === 'nickname') { // FITUR BARU: Update Nickname Peer
                    displayMessage('system', `Peer mengubah nama menjadi '${data.name}'`);
                }
            } catch (e) { // Ini adalah pesan chat terenkripsi
                const decryptedMessage = await decryptMessage(cryptoKey, event.data);
                displayMessage('peer', decryptedMessage);
                typingIndicator.textContent = ''; // Hapus indikator setelah pesan diterima
            }
        };
    }
    
    function promptForNickname() {
        const name = prompt("Masukkan nickname untuk sesi ini:", "anon");
        if (name) {
            nickname = name;
            chatPrefix.textContent = `[${nickname}]$`;
            ws.send(JSON.stringify({ type: 'nickname', name: nickname, roomId: roomId })); // Beri tahu peer lain
        }
        messageInput.disabled = false;
        messageInput.focus();
    }
    
    // === Alur WebRTC (Tidak Berubah) ===
    async function createOffer() { setupPeerConnection(); dataChannel = peerConnection.createDataChannel('mrvx-channel'); setupDataChannelEvents(); const offer = await peerConnection.createOffer(); await peerConnection.setLocalDescription(offer); ws.send(JSON.stringify({ type: 'offer', offer: offer, roomId: roomId })); }
    async function handleOffer(offer) { setupPeerConnection(); await peerConnection.setRemoteDescription(new RTCSessionDescription(offer)); const answer = await peerConnection.createAnswer(); await peerConnection.setLocalDescription(answer); ws.send(JSON.stringify({ type: 'answer', answer: answer, roomId: roomId })); }
    async function handleAnswer(answer) { if (peerConnection?.signalingState === 'have-local-offer') await peerConnection.setRemoteDescription(new RTCSessionDescription(answer)); }

    // === Logika UI & Chat ===
    function displayMessage(sender, message) {
        const p = document.createElement('p');
        if (sender === 'me') p.innerHTML = `<span class="nickname">[${nickname}]$</span> ${message}`;
        else if (sender === 'peer') p.innerHTML = `<span class="nickname">[peer]$</span> ${message}`;
        else { p.textContent = message; p.classList.add('system-message'); }
        chatLog.appendChild(p);
        chatLog.scrollTop = chatLog.scrollHeight;
    }
    async function sendMessage() {
        const messageText = messageInput.value;
        if (messageText.trim() === '' || !dataChannel || dataChannel.readyState !== 'open') return;
        const encryptedMessage = await encryptMessage(cryptoKey, messageText);
        dataChannel.send(encryptedMessage);
        displayMessage('me', messageText);
        messageInput.value = '';
    }
    
    // === Event Listeners ===
    createRoomButton.addEventListener('click', async () => {
        createRoomButton.disabled = true; creatorView.style.display = 'none'; invitationView.style.display = 'block';
        updateStatus('Membuat kunci enkripsi baru...', true);
        cryptoKey = await createNewKey();
        const keyString = await exportKeyToString(cryptoKey);
        updateStatus('Membuat ID Room unik...', true);
        roomId = crypto.randomUUID();
        const inviteLink = `${window.location.origin}${window.location.pathname}#${roomId}:${keyString}`;
        inviteLinkOutput.value = inviteLink;
        window.history.pushState(null, '', inviteLink);
        connectToSignalingServer(true);
    });

    copyLinkButton.addEventListener('click', () => { // FITUR BARU: Copy API Modern
        navigator.clipboard.writeText(inviteLinkOutput.value).then(() => {
            copyLinkButton.textContent = '[ Tersalin! ]';
            setTimeout(() => { copyLinkButton.textContent = '[ Salin Link ]'; }, 2000);
        }).catch(err => console.error('Gagal menyalin:', err));
    });
    
    messageInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') sendMessage(); });
    messageInput.addEventListener('input', () => { // FITUR BARU: Kirim status mengetik
        if (dataChannel && dataChannel.readyState === 'open') {
            dataChannel.send(JSON.stringify({ type: 'typing' }));
        }
    });

    init();
});
