document.addEventListener('DOMContentLoaded', () => {
    // === Konfigurasi & Seleksi Elemen DOM ===
    const SIGNALING_SERVER_URL = 'wss://safe-salty-sand.glitch.me/'; // Server publik gratis
    const STUN_SERVER = 'stun:stun.l.google.com:19302';

    const screens = {
        auth: document.getElementById('auth-screen'),
        chat: document.getElementById('chat-screen'),
    };
    const roomCodeInput = document.getElementById('room-code-input');
    const nicknameInput = document.getElementById('nickname-input');
    const joinButton = document.getElementById('join-button');
    const statusText = document.getElementById('status-text');
    const messageInput = document.getElementById('message-input');
    const chatLog = document.getElementById('chat-log');
    const chatPrefix = document.getElementById('chat-prefix');

    // === State Aplikasi ===
    let cryptoKey = null;
    let nickname = '';
    let roomId = null;
    let peerConnection;
    let dataChannel;
    let ws;

    // === Fungsi Utama ===

    function showScreen(screenName) {
        Object.values(screens).forEach(screen => screen.classList.remove('active'));
        screens[screenName].classList.add('active');
    }

    function updateStatus(message) {
        statusText.textContent = `> ${message}`;
    }

    async function generateRoomId(password) {
        const encoder = new TextEncoder();
        const data = encoder.encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        // Ubah hash menjadi string hex untuk ID yang unik dan aman
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // === Logika Kriptografi ===
    async function deriveKeyFromPassword(password) {
        const encoder = new TextEncoder();
        const passwordBuffer = encoder.encode(password);
        const salt = encoder.encode('MRVX_SALT_V2.1'); // Ganti salt untuk versi baru
        const importedKey = await crypto.subtle.importKey('raw', passwordBuffer, { name: 'PBKDF2' }, false, ['deriveKey']);
        return await crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
            importedKey, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']
        );
    }

    async function encryptMessage(key, plainText) {
        const encoder = new TextEncoder();
        const encodedText = encoder.encode(plainText);
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const encryptedData = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, encodedText);
        const ivB64 = btoa(String.fromCharCode.apply(null, iv));
        const cipherB64 = btoa(String.fromCharCode.apply(null, new Uint8Array(encryptedData)));
        return JSON.stringify({ iv: ivB64, ciphertext: cipherB64 });
    }

    async function decryptMessage(key, encryptedPayload) {
        try {
            const { iv: ivB64, ciphertext: cipherB64 } = JSON.parse(encryptedPayload);
            const iv = new Uint8Array(atob(ivB64).split('').map(c => c.charCodeAt(0)));
            const ciphertext = new Uint8Array(atob(cipherB64).split('').map(c => c.charCodeAt(0)));
            const decryptedBuffer = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ciphertext);
            const decoder = new TextDecoder();
            return decoder.decode(decryptedBuffer);
        } catch (error) {
            console.error('Dekripsi gagal:', error);
            return '[[ PESAN GAGAL DIDEKRIPSI - KODE AKSES MUNGKIN SALAH ]]';
        }
    }

    // === Logika Signaling & WebRTC ===

    function connectToSignalingServer() {
        updateStatus('Menghubungkan ke signaling server...');
        ws = new WebSocket(SIGNALING_SERVER_URL);

        ws.onopen = () => {
            updateStatus('Terhubung. Bergabung ke room...');
            const joinMessage = { type: 'join', roomId: roomId };
            ws.send(JSON.stringify(joinMessage));
        };

        ws.onmessage = async (event) => {
            const message = JSON.parse(event.data);
            switch (message.type) {
                case 'room-created': // Anda orang pertama
                    updateStatus('Room berhasil dibuat. Menunggu teman...');
                    break;
                case 'room-joined': // Anda orang kedua
                    updateStatus('Berhasil gabung ke room. Menunggu teman...');
                    break;
                case 'peer-joined': // Untuk orang pertama, saat orang kedua gabung
                    updateStatus('Teman terdeteksi! Memulai negosiasi...');
                    await createOffer();
                    break;
                case 'offer': // Untuk orang kedua, menerima offer
                    updateStatus('Menerima penawaran, membalas...');
                    await handleOffer(message.offer);
                    break;
                case 'answer': // Untuk orang pertama, menerima answer
                    updateStatus('Jawaban diterima, menyelesaikan koneksi...');
                    await handleAnswer(message.answer);
                    break;
                case 'ice-candidate':
                    if (peerConnection) {
                        await peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate));
                    }
                    break;
                case 'room-full':
                    updateStatus('ERROR: Room sudah penuh.');
                    ws.close();
                    joinButton.disabled = false;
                    break;
            }
        };

        ws.onerror = (error) => {
            console.error('WebSocket Error:', error);
            updateStatus('ERROR: Tidak bisa terhubung ke signaling server.');
            joinButton.disabled = false;
        };
        
        ws.onclose = () => {
            if (peerConnection?.connectionState !== 'connected') {
                 updateStatus('Koneksi ke signaling server terputus.');
                 joinButton.disabled = false;
            }
        };
    }

    function setupPeerConnection() {
        peerConnection = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                // Kirim ICE candidate ke peer lain melalui signaling server
                ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    candidate: event.candidate,
                    roomId: roomId
                }));
            }
        };
        
        peerConnection.onconnectionstatechange = () => {
            if (peerConnection.connectionState === 'connected') {
                updateStatus('Koneksi P2P aman terbentuk!');
                setTimeout(() => showScreen('chat'), 1000); // Tunda sedikit untuk transisi
            }
             if (peerConnection.connectionState === 'failed') {
                updateStatus('Koneksi P2P gagal.');
                peerConnection.close();
                ws.close();
             }
        };

        peerConnection.ondatachannel = (event) => {
            dataChannel = event.channel;
            setupDataChannelEvents();
        };
    }

    function setupDataChannelEvents() {
        dataChannel.onopen = () => {
            displayMessage('system', '-- Sesi Aman Aktif. Riwayat tidak disimpan. Tutup tab untuk mengakhiri. --');
        };
        dataChannel.onclose = () => {
            displayMessage('system', '-- Teman terputus. Sesi berakhir. --');
        };
        dataChannel.onmessage = async (event) => {
            const decryptedMessage = await decryptMessage(cryptoKey, event.data);
            displayMessage('peer', decryptedMessage);
        };
    }

    async function createOffer() {
        setupPeerConnection();
        dataChannel = peerConnection.createDataChannel('mrvx-channel');
        setupDataChannelEvents();
        
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        ws.send(JSON.stringify({ type: 'offer', offer: offer, roomId: roomId }));
    }

    async function handleOffer(offer) {
        setupPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        ws.send(JSON.stringify({ type: 'answer', answer: answer, roomId: roomId }));
    }

    async function handleAnswer(answer) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }

    // === Logika Chat ===
    function displayMessage(sender, message) {
        const p = document.createElement('p');
        if (sender === 'me') {
            p.innerHTML = `<span class="nickname">[${nickname}]</span>: ${message}`;
        } else if (sender === 'peer') {
            p.innerHTML = `<span class="nickname">[peer]</span>: ${message}`;
        } else {
            p.textContent = message;
            p.classList.add('system-message');
        }
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
    joinButton.addEventListener('click', async () => {
        const roomPassword = roomCodeInput.value;
        nickname = nicknameInput.value.trim() || 'anon';
        
        if (roomPassword.length < 8) {
            alert('Kode Akses harus minimal 8 karakter.');
            return;
        }

        joinButton.disabled = true;
        chatPrefix.textContent = `[${nickname}]$`;

        try {
            updateStatus('Mempersiapkan kunci enkripsi...');
            [cryptoKey, roomId] = await Promise.all([
                deriveKeyFromPassword(roomPassword),
                generateRoomId(roomPassword)
            ]);
            connectToSignalingServer();
        } catch (error) {
            console.error("Gagal memulai:", error);
            updateStatus('ERROR: Gagal mempersiapkan sesi.');
            joinButton.disabled = false;
        }
    });

    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });
});
