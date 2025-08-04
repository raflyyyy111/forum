document.addEventListener('DOMContentLoaded', () => {
    // === Bagian 1: Seleksi Elemen DOM & State Aplikasi ===
    const screens = {
        auth: document.getElementById('auth-screen'),
        identity: document.getElementById('identity-screen'),
        signaling: document.getElementById('signaling-screen'),
        chat: document.getElementById('chat-screen'),
    };

    // Input & Tombol
    const roomCodeInput = document.getElementById('room-code-input');
    const authButton = document.getElementById('auth-button');
    const nicknameInput = document.getElementById('nickname-input');
    const createRoomButton = document.getElementById('create-room-button');
    const joinRoomButton = document.getElementById('join-room-button');
    const offerTokenOutput = document.getElementById('offer-token-output');
    const answerTokenInput = document.getElementById('answer-token-input');
    const connectButton = document.getElementById('connect-button');
    const offerTokenInput = document.getElementById('offer-token-input');
    const createAnswerButton = document.getElementById('create-answer-button');
    const answerTokenOutput = document.getElementById('answer-token-output');
    const messageInput = document.getElementById('message-input');
    const chatLog = document.getElementById('chat-log');
    const chatPrefix = document.getElementById('chat-prefix');

    // Instruksi Sinyal
    const peerAInstructions = document.getElementById('peer-a-instructions');
    const peerBInstructions = document.getElementById('peer-b-instructions');
    
    // State Aplikasi
    let cryptoKey = null;
    let nickname = '';
    let peerConnection;
    let dataChannel;
    
    const STUN_SERVER = 'stun:stun.l.google.com:19302';

    // === Bagian 2: Logika UI & Navigasi Layar ===
    function showScreen(screenName) {
        Object.values(screens).forEach(screen => screen.classList.remove('active'));
        screens[screenName].classList.add('active');
    }

    // === Bagian 3: Logika Kriptografi (Web Crypto API) ===
    async function deriveKeyFromPassword(password) {
        const encoder = new TextEncoder();
        const passwordBuffer = encoder.encode(password);
        const salt = encoder.encode('MRVX_SALT'); // Salt statis untuk kesederhanaan PoC

        const importedKey = await crypto.subtle.importKey(
            'raw',
            passwordBuffer,
            { name: 'PBKDF2' },
            false,
            ['deriveKey']
        );

        return await crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: salt,
                iterations: 100000,
                hash: 'SHA-256',
            },
            importedKey,
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
    }

    async function encryptMessage(key, plainText) {
        const encoder = new TextEncoder();
        const encodedText = encoder.encode(plainText);
        const iv = window.crypto.getRandomValues(new Uint8Array(12)); // IV harus unik per enkripsi
        
        const encryptedData = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: iv },
            key,
            encodedText
        );
        
        // Gabungkan IV dan ciphertext untuk dikirim. Base64 untuk pengiriman teks yang aman.
        const ivB64 = btoa(String.fromCharCode.apply(null, iv));
        const cipherB64 = btoa(String.fromCharCode.apply(null, new Uint8Array(encryptedData)));

        return JSON.stringify({ iv: ivB64, ciphertext: cipherB64 });
    }
    
    async function decryptMessage(key, encryptedPayload) {
        try {
            const { iv: ivB64, ciphertext: cipherB64 } = JSON.parse(encryptedPayload);
            
            const iv = new Uint8Array(atob(ivB64).split('').map(c => c.charCodeAt(0)));
            const ciphertext = new Uint8Array(atob(cipherB64).split('').map(c => c.charCodeAt(0)));
            
            const decryptedBuffer = await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: iv },
                key,
                ciphertext
            );

            const decoder = new TextDecoder();
            return decoder.decode(decryptedBuffer);
        } catch (error) {
            console.error('Dekripsi gagal:', error);
            return '[[ PESAN GAGAL DIDEKRIPSI - KODE AKSES MUNGKIN SALAH ]]';
        }
    }


    // === Bagian 4: Logika WebRTC (P2P Connection) ===
    function setupPeerConnection() {
        peerConnection = new RTCPeerConnection({ iceServers: [{ urls: STUN_SERVER }] });

        peerConnection.onicecandidate = event => {
            // Dalam sinyal manual, ICE candidates biasanya sudah dibundel dalam offer/answer
            // Namun, event handler ini penting untuk sinyal otomatis nantinya.
            if (event.candidate) {
                console.log('New ICE candidate:', event.candidate);
            }
        };
        
        peerConnection.onconnectionstatechange = () => {
            console.log('Connection state:', peerConnection.connectionState);
            if (peerConnection.connectionState === 'connected') {
                showScreen('chat');
            }
        };
        
        // Peer B menerima data channel dari Peer A
        peerConnection.ondatachannel = event => {
            dataChannel = event.channel;
            setupDataChannelEvents();
        };
    }

    function setupDataChannelEvents() {
        dataChannel.onopen = () => console.log('Data channel terbuka!');
        dataChannel.onclose = () => console.log('Data channel tertutup.');
        dataChannel.onmessage = async (event) => {
            const decryptedMessage = await decryptMessage(cryptoKey, event.data);
            displayMessage('peer', decryptedMessage);
        };
    }

    async function createOffer() {
        setupPeerConnection();
        // Peer A membuat data channel
        dataChannel = peerConnection.createDataChannel('mrvx-channel');
        setupDataChannelEvents();
        
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        
        offerTokenOutput.value = JSON.stringify(peerConnection.localDescription);
    }
    
    async function createAnswer() {
        if (!offerTokenInput.value) {
            alert('Tempel Offer Token dari Peer A terlebih dahulu.');
            return;
        }
        setupPeerConnection();
        
        const offer = JSON.parse(offerTokenInput.value);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        answerTokenOutput.value = JSON.stringify(peerConnection.localDescription);
    }
    
    async function acceptAnswer() {
        if (!answerTokenInput.value) {
            alert('Tempel Answer Token dari Peer B terlebih dahulu.');
            return;
        }
        const answer = JSON.parse(answerTokenInput.value);
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }
    
    // === Bagian 5: Logika Chat ===
    function displayMessage(sender, message) {
        const p = document.createElement('p');
        if (sender === 'me') {
            p.innerHTML = `<span class="nickname">[${nickname}]</span>: ${message}`;
        } else if (sender === 'peer') {
            p.innerHTML = `<span class="nickname">[peer]</span>: ${message}`;
        } else { // system
            p.textContent = message;
            p.classList.add('system-message');
        }
        chatLog.appendChild(p);
        chatLog.scrollTop = chatLog.scrollHeight; // Auto-scroll
    }
    
    async function sendMessage() {
        const messageText = messageInput.value;
        if (messageText.trim() === '' || !dataChannel || dataChannel.readyState !== 'open') {
            return;
        }
        
        const encryptedMessage = await encryptMessage(cryptoKey, messageText);
        dataChannel.send(encryptedMessage);
        
        displayMessage('me', messageText);
        messageInput.value = '';
    }

    // === Bagian 6: Event Listeners ===
    authButton.addEventListener('click', async () => {
        if (roomCodeInput.value.length < 8) {
            alert('Kode Akses harus minimal 8 karakter.');
            return;
        }
        try {
            cryptoKey = await deriveKeyFromPassword(roomCodeInput.value);
            showScreen('identity');
        } catch (error) {
            console.error("Gagal membuat kunci:", error);
            alert('Gagal memproses kode. Coba lagi.');
        }
    });

    createRoomButton.addEventListener('click', () => {
        nickname = nicknameInput.value.trim() || 'anon';
        chatPrefix.textContent = `[${nickname}]$`;
        showScreen('signaling');
        peerAInstructions.style.display = 'block';
        createOffer();
    });

    joinRoomButton.addEventListener('click', () => {
        nickname = nicknameInput.value.trim() || 'anon';
        chatPrefix.textContent = `[${nickname}]$`;
        showScreen('signaling');
        peerBInstructions.style.display = 'block';
    });

    createAnswerButton.addEventListener('click', createAnswer);
    connectButton.addEventListener('click', acceptAnswer);

    messageInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            sendMessage();
        }
    });

    // Otomatis fokus ke input saat layar berganti
    new MutationObserver(() => {
        if (screens.auth.classList.contains('active')) roomCodeInput.focus();
        if (screens.identity.classList.contains('active')) nicknameInput.focus();
    }).observe(document.body, { childList: true, subtree: true });
});
