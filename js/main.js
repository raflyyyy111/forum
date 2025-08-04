document.addEventListener('DOMContentLoaded', () => {
    const SIGNALING_SERVER_URL = 'wss://safe-salty-sand.glitch.me/';
    const STUN_SERVER = 'stun:stun.l.google.com:19302';

    const screens = {
        main: document.getElementById('main-screen'),
        chat: document.getElementById('chat-screen'),
    };
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

    let cryptoKey = null;
    let roomId = null;
    let peerConnection;
    let dataChannel;
    let ws;

    async function init() {
        if (window.location.hash) {
            creatorView.style.display = 'none';
            joinerView.style.display = 'block';
            try {
                const hashContent = window.location.hash.substring(1);
                const [parsedRoomId, keyString] = hashContent.split(':');
                if (!parsedRoomId || !keyString) throw new Error('Link undangan tidak valid.');
                roomId = parsedRoomId;
                updateStatus('Kunci terdeteksi. Mengimpor kunci enkripsi...');
                cryptoKey = await importKeyFromString(keyString);
                connectToSignalingServer();
            } catch (error) {
                updateStatus(`ERROR: ${error.message}`);
            }
        } else {
            creatorView.style.display = 'block';
            joinerView.style.display = 'none';
        }
    }

    function showScreen(screenName) {
        Object.values(screens).forEach(screen => screen.classList.remove('active'));
        screens[screenName].classList.add('active');
    }

    function updateStatus(message, isCreator = false) {
        const target = isCreator ? creatorStatusText : statusText;
        target.textContent = `> ${message}`;
    }

    async function createNewKey() {
        return await crypto.subtle.generateKey(
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
    }

    async function exportKeyToString(key) {
        const exported = await crypto.subtle.exportKey('jwk', key);
        return btoa(JSON.stringify(exported));
    }

    async function importKeyFromString(keyString) {
        const jwk = JSON.parse(atob(keyString));
        return await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'AES-GCM' },
            true,
            ['encrypt', 'decrypt']
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
            console.error('Decryption failed:', error);
            return '[[ PESAN GAGAL DIDEKRIPSI ]]';
        }
    }

    function connectToSignalingServer(isCreator = false) {
        updateStatus('Menghubungkan ke signaling server...', isCreator);
        ws = new WebSocket(SIGNALING_SERVER_URL);

        ws.onopen = () => {
            updateStatus('Terhubung. Bergabung ke room...', isCreator);
            ws.send(JSON.stringify({ type: 'join', roomId: roomId }));
        };

        ws.onmessage = async (event) => {
            const message = JSON.parse(event.data);
            switch (message.type) {
                case 'room-created':
                    updateStatus('Room berhasil dibuat. Menunggu teman...', true);
                    break;
                case 'room-joined':
                    updateStatus('Berhasil gabung ke room. Menunggu teman...');
                    break;
                case 'peer-joined':
                    updateStatus('Teman terdeteksi! Memulai negosiasi...', true);
                    await createOffer();
                    break;
                case 'offer':
                    updateStatus('Menerima penawaran, membalas...');
                    await handleOffer(message.offer);
                    break;
                case 'answer':
                    updateStatus('Jawaban diterima, menyelesaikan koneksi...', true);
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
                    break;
            }
        };

        ws.onerror = (error) => {
            console.error('WebSocket Error:', error);
            updateStatus('ERROR: Gagal terhubung ke signaling server.', isCreator);
        };
        
        ws.onclose = () => {
            if (peerConnection?.connectionState !== 'connected') {
                 updateStatus('Koneksi ke signaling server terputus.', isCreator);
            }
        };
    }

    function setupPeerConnection() {
        peerConnection = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });

        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                ws.send(JSON.stringify({
                    type: 'ice-candidate',
                    candidate: event.candidate,
                    roomId: roomId
                }));
            }
        };
        
        peerConnection.onconnectionstatechange = () => {
            const state = peerConnection.connectionState;
            if (state === 'connected') {
                updateStatus('Koneksi P2P aman terbentuk!', true);
                updateStatus('Koneksi P2P aman terbentuk!');
                setTimeout(() => showScreen('chat'), 1000);
            }
             if (state === 'failed' || state === 'disconnected' || state === 'closed') {
                updateStatus('Koneksi P2P gagal atau terputus.');
                if (ws.readyState === WebSocket.OPEN) ws.close();
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
        if (peerConnection?.signalingState === 'have-local-offer') {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        }
    }

    function displayMessage(sender, message) {
        const p = document.createElement('p');
        if (sender === 'me') {
            p.innerHTML = `<span class="nickname">[me]$</span> ${message}`;
        } else if (sender === 'peer') {
            p.innerHTML = `<span class="nickname">[peer]$</span> ${message}`;
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

    createRoomButton.addEventListener('click', async () => {
        createRoomButton.disabled = true;
        creatorView.style.display = 'none';
        invitationView.style.display = 'block';
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

    copyLinkButton.addEventListener('click', () => {
        inviteLinkOutput.select();
        document.execCommand('copy');
        copyLinkButton.textContent = '[ Tersalin! ]';
        setTimeout(() => { copyLinkButton.textContent = '[ Salin Link ]'; }, 2000);
    });
    
    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

    init();
});
