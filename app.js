document.addEventListener('DOMContentLoaded', () => {
    const isObs = navigator.userAgent.includes('OBS');
    const container = document.querySelector('.container');
    let audioContext;
    const sounds = {}; // Store audio buffers and nodes
    let globalSettings = {}; // Store settings from server
    let ws;

    // --- 通知システム ---
    function showNotification(message, type = 'info', duration = 3000) {
        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.textContent = message;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 15px 20px;
            border-radius: 12px;
            background: ${type === 'error' ? 'linear-gradient(135deg, #dc3545 0%, #c82333 100%)' : 
                         type === 'success' ? 'linear-gradient(135deg, #28a745 0%, #20c997 100%)' : 
                         'linear-gradient(135deg, #007bff 0%, #0056b3 100%)'};
            color: white;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            z-index: 10000;
            animation: slideInRight 0.3s ease;
            max-width: 300px;
            word-wrap: break-word;
        `;
        
        document.body.appendChild(notification);
        
        setTimeout(() => {
            notification.style.animation = 'slideOutRight 0.3s ease';
            setTimeout(() => notification.remove(), 300);
        }, duration);
    }

    // --- WebSocket Connection ---
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${protocol}://${window.location.host}`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
            console.log(`WebSocket connected to ${wsUrl}`);
            showNotification('サーバーに接続しました', 'success', 2000);
        };
        
        ws.onclose = () => {
            console.log('WebSocket disconnected. Retrying in 2s...');
            showNotification('サーバーとの接続が切れました', 'error', 2000);
            setTimeout(connectWebSocket, 2000);
        };
        
        ws.onerror = (err) => {
            console.error('WebSocket Error:', err);
            showNotification('接続エラーが発生しました', 'error');
        };

        ws.onmessage = (event) => {
            try {
                const command = JSON.parse(event.data);
                handleCommand(command);
            } catch (e) {
                console.error('Failed to parse command:', event.data);
                showNotification('コマンドの解析に失敗しました', 'error');
            }
        };
    }

    // --- Command Sender ---
    function sendCommand(command) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(command));
        } else {
            showNotification('サーバーに接続されていません', 'error');
        }
    }

    // --- Audio Engine (for OBS) ---
    async function initializeAudioEngine() {
        // AudioContextの初期化（初回のみ）
        if (!audioContext) {
            try {
                audioContext = new (window.AudioContext || window.webkitAudioContext)();
                if (audioContext.state === 'suspended') {
                    await audioContext.resume();
                }
            } catch (e) {
                console.error('AudioContext initialization failed:', e);
                showNotification('音声エンジンの初期化に失敗しました', 'error');
                return;
            }
        }

        // 既存のサウンドをクリア（再初期化時）
        Object.values(sounds).forEach(sound => {
            if (sound.source) {
                sound.source.onended = null;
                sound.source.stop();
            }
        });
        
        // soundsオブジェクトをクリア
        for (let key in sounds) {
            if (key !== 'masterVolume') {
                delete sounds[key];
            }
        }

        const response = await fetch('/sounds');
        const data = await response.json();
        
        // カテゴリ内のファイルを処理
        Object.keys(data.categories || {}).forEach(category => {
            data.categories[category].forEach(fileInfo => {
                const soundId = `sound-${encodeURIComponent(category)}-${encodeURIComponent(fileInfo.name)}`;
                const gainNode = audioContext.createGain();
                gainNode.connect(audioContext.destination);
                sounds[soundId] = {
                    id: soundId,
                    name: fileInfo.name,
                    category: category,
                    src: fileInfo.path,
                    gainNode: gainNode,
                    volume: 1,
                    buffer: null,
                    source: null
                };
            });
        });
        
        // ルートディレクトリのファイルを処理
        (data.files || []).forEach(fileInfo => {
            const soundId = `sound-${encodeURIComponent(fileInfo.name)}`;
            const gainNode = audioContext.createGain();
            gainNode.connect(audioContext.destination);
            sounds[soundId] = {
                id: soundId,
                name: fileInfo.name,
                category: null,
                src: fileInfo.path,
                gainNode: gainNode,
                volume: 1,
                buffer: null,
                source: null
            };
        });
        
        // Apply initial settings once sounds are loaded
        applyAllSettings(globalSettings);
    }

    async function loadSound(soundId) {
        const sound = sounds[soundId];
        if (!sound || sound.buffer) return;
        try {
            const response = await fetch(sound.src);
            const arrayBuffer = await response.arrayBuffer();
            sound.buffer = await audioContext.decodeAudioData(arrayBuffer);
        } catch (error) {
            console.error(`Error loading sound ${sound.name}:`, error);
        }
    }

    function playSound(soundId) {
        const sound = sounds[soundId];
        if (!sound) return;

        // Load the sound if it's not already loaded
        if (!sound.buffer) {
            loadSound(soundId).then(() => {
                if (sound.buffer) playSound(soundId); // Retry playing after loading
            });
            return;
        }

        // Stop the currently playing instance of the same sound to allow for re-triggering
        if (sound.source) {
            sound.source.onended = null; // Remove the event listener to prevent unwanted side-effects
            sound.source.stop();
        }

        // Create a new buffer source for each playback
        const source = audioContext.createBufferSource();
        source.buffer = sound.buffer;
        source.connect(sound.gainNode);
        source.start(0);

        // Keep track of the new source
        sound.source = source;

        // Notify remotes that the sound has started
        sendCommand({ action: 'sound_started', soundId });

        // Set up the onended event for the new source
        source.onended = () => {
            // Check if this is the currently active source before clearing
            if (sound.source === source) {
                sendCommand({ action: 'sound_ended', soundId });
                sound.source = null;
            }
        };
    }


    // --- Settings Application ---
    function applyAllSettings(settings) {
        globalSettings = settings;
        if (isObs) {
            // Apply master volume
            const masterVolume = settings.masterVolume || 1;
            sounds.masterVolume = masterVolume;
            // Apply individual sound volumes
            Object.keys(settings.sounds || {}).forEach(soundId => {
                const soundSettings = settings.sounds[soundId];
                const sound = sounds[soundId];
                if (sound && soundSettings) {
                    sound.volume = soundSettings.volume || 1;
                    if(sound.gainNode) sound.gainNode.gain.value = sound.volume * masterVolume;
                }
            });
        } else {
            // Apply UI settings for remote
            const soundBoard = document.getElementById('sound-board');
            const masterVolumeSlider = document.getElementById('master-volume');
            const columnsInput = document.getElementById('columns-input');
            const sortBySelect = document.getElementById('sort-by');
            const sortOrderSelect = document.getElementById('sort-order');

            if (masterVolumeSlider) masterVolumeSlider.value = settings.masterVolume || 1;
            if (columnsInput) columnsInput.value = settings.columns || 3;
            if (sortBySelect) sortBySelect.value = settings.sortBy || 'name';
            if (sortOrderSelect) sortOrderSelect.value = settings.sortOrder || 'asc';
            if (soundBoard) soundBoard.style.setProperty('--columns', settings.columns || 3);

            Object.keys(settings.sounds || {}).forEach(soundId => {
                const soundSettings = settings.sounds[soundId];
                const button = document.querySelector(`.sound-btn[data-id="${soundId}"]`);
                if (button) {
                    if (soundSettings.color) button.style.backgroundColor = soundSettings.color;
                    const volumeSlider = button.querySelector('.volume-slider');
                    if (volumeSlider) volumeSlider.value = soundSettings.volume || 1;
                }
            });
        }
    }

    function applySettingChange({ soundId, setting, value }) {
         if (soundId) { // Sound-specific setting
            const sound = sounds[soundId];
            const button = document.querySelector(`.sound-btn[data-id="${soundId}"]`);
            if (setting === 'volume') {
                if (isObs && sound) {
                    sound.volume = value;
                    sound.gainNode.gain.value = sound.volume * (sounds.masterVolume || 1);
                } else if(button) {
                    const volumeSlider = button.querySelector('.volume-slider');
                    if (volumeSlider) volumeSlider.value = value;
                }
            }
            if (setting === 'color' && button) {
                button.style.backgroundColor = value;
            }
        } else { // Global setting
            if (setting === 'masterVolume') {
                if (isObs) {
                    sounds.masterVolume = value;
                    Object.values(sounds).forEach(s => {
                        if(s.gainNode) s.gainNode.gain.value = s.volume * value;
                    });
                } else {
                    const masterVolumeSlider = document.getElementById('master-volume');
                    if (masterVolumeSlider) masterVolumeSlider.value = value;
                }
            }
             if (setting === 'columns') {
                const soundBoard = document.getElementById('sound-board');
                if (soundBoard) soundBoard.style.setProperty('--columns', value);
            }
        }
    }


    // --- Command Handler ---
    function handleCommand(command) {
        const { action, soundId, settings, setting, value } = command;

        if (action === 'settings_initialized' || action === 'settings_updated') {
            applyAllSettings(settings);
            return;
        }
        if (action === 'setting_changed') {
            applySettingChange({ soundId, setting, value });
            return;
        }

        // サウンドファイル更新通知
        if (action === 'sounds_updated') {
            console.log('サウンドファイルが更新されました。再読み込みします...');
            
            if (isObs) {
                // OBSモード: オーディオエンジンを再初期化
                initializeAudioEngine().then(() => {
                    console.log('OBS: サウンドファイルを再読み込みしました');
                });
            } else {
                // リモートUIモード: サウンド一覧を再取得して再描画
                fetch('/sounds').then(res => res.json()).then(data => {
                    soundsData = data;
                    // 設定も再取得
                    fetch('/api/settings').then(res => res.json()).then(settings => {
                        globalSettings = settings;
                        const sortBy = settings.sortBy || 'name';
                        const sortOrder = settings.sortOrder || 'asc';
                        const customOrder = settings.customOrder || [];
                        const customCategoryOrder = settings.customCategoryOrder || [];
                        renderSoundBoard(data, sortBy, sortOrder, customOrder, customCategoryOrder);
                        console.log('Remote: サウンドボードを再描画しました');
                    });
                });
            }
            return;
        }

        if (isObs) {
            switch (action) {
                case 'play':
                    playSound(soundId);
                    break;
                case 'stopAll':
                    Object.values(sounds).forEach(s => {
                        if (s.source) {
                            s.source.onended = null;
                            s.source.stop();
                            s.source = null;
                            sendCommand({ action: 'sound_ended', soundId: s.id });
                        }
                    });
                    break;
                // Volume setting is now handled by 'setting_changed'
            }
        } else {
            const button = document.querySelector(`.sound-btn[data-id="${soundId}"]`);
            if (!button) return;

            switch (action) {
                case 'sound_started':
                    button.classList.add('playing');
                    break;
                case 'sound_ended':
                    button.classList.remove('playing');
                    break;
            }
        }
    }

    // --- UI Initialization (for Remote) ---
    function initializeRemoteUI() {
        const soundBoard = document.getElementById('sound-board');
        const masterVolumeSlider = document.getElementById('master-volume');
        const stopAllBtn = document.getElementById('stop-all-btn');
        const settingsBtn = document.getElementById('settings-btn');
        const volumeModeBtn = document.getElementById('volume-mode-btn');
        const modal = document.getElementById('settings-modal');
        const closeBtn = document.querySelector('.close-btn');
        const columnsInput = document.getElementById('columns-input');

        const colorPresets = ['#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8', '#6f42c1'];

        // ドラッグ中の自動スクロール
        let autoScrollInterval = null;
        const startAutoScroll = (clientY) => {
            if (autoScrollInterval) return;
            
            autoScrollInterval = setInterval(() => {
                const scrollThreshold = 100; // スクロール開始の閾値（ピクセル）
                const scrollSpeed = 10; // スクロール速度
                
                const windowHeight = window.innerHeight;
                
                if (clientY < scrollThreshold) {
                    // 上方向にスクロール
                    window.scrollBy(0, -scrollSpeed);
                } else if (clientY > windowHeight - scrollThreshold) {
                    // 下方向にスクロール
                    window.scrollBy(0, scrollSpeed);
                }
            }, 16); // 約60fps
        };
        
        const stopAutoScroll = () => {
            if (autoScrollInterval) {
                clearInterval(autoScrollInterval);
                autoScrollInterval = null;
            }
        };

        const createButton = (sound) => {
            const button = document.createElement('div');
            button.className = 'sound-btn';
            button.dataset.id = sound.id;
            button.dataset.category = sound.category || '';
            button.dataset.name = sound.name;

            const presetsHTML = colorPresets.map(color =>
                `<div class="color-swatch" style="background-color: ${color};" data-color="${color}"></div>`
            ).join('');

            button.innerHTML = `
                <div class="btn-name">${sound.name.replace(/\.[^/.]+$/, "")}</div>
                <div class="controls-wrapper">
                    <input type="range" class="volume-slider" min="0" max="1" step="0.01" value="1">
                    <div class="color-presets">${presetsHTML}</div>
                </div>
            `;

            button.addEventListener('click', (e) => {
                if (!document.body.classList.contains('volume-adjust-mode') && 
                    !document.body.classList.contains('sort-mode')) {
                    
                    // リップル効果を追加
                    const ripple = document.createElement('span');
                    const rect = button.getBoundingClientRect();
                    const size = Math.max(rect.width, rect.height);
                    const x = e.clientX - rect.left - size / 2;
                    const y = e.clientY - rect.top - size / 2;
                    
                    ripple.style.cssText = `
                        position: absolute;
                        border-radius: 50%;
                        background: rgba(255, 255, 255, 0.6);
                        width: ${size}px;
                        height: ${size}px;
                        left: ${x}px;
                        top: ${y}px;
                        pointer-events: none;
                        animation: ripple 0.6s ease-out;
                    `;
                    
                    button.style.position = 'relative';
                    button.style.overflow = 'hidden';
                    button.appendChild(ripple);
                    
                    setTimeout(() => ripple.remove(), 600);
                    
                    sendCommand({ action: 'play', soundId: sound.id });
                }
            });

            // ドラッグ&ドロップイベント
            button.setAttribute('draggable', 'false'); // 初期状態では無効
            
            button.addEventListener('dragstart', (e) => {
                if (!document.body.classList.contains('sort-mode')) {
                    e.preventDefault();
                    return;
                }
                
                button.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/html', button.innerHTML);
                e.dataTransfer.setData('sound-id', sound.id);
                
                // 既存の全てのドラッグ画像を確実に削除
                document.querySelectorAll('.temp-drag-image').forEach(img => {
                    img.remove();
                });
                
                // シンプルなドラッグ画像を作成（深いクローンを使わない）
                const dragImage = document.createElement('div');
                dragImage.className = 'temp-drag-image';
                dragImage.textContent = button.textContent;
                dragImage.style.cssText = `
                    position: absolute;
                    top: -10000px;
                    left: -10000px;
                    width: ${button.offsetWidth}px;
                    height: ${button.offsetHeight}px;
                    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                    color: white;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    border-radius: 12px;
                    font-size: 16px;
                    font-weight: 600;
                    box-shadow: 0 8px 16px rgba(0,0,0,0.3);
                    opacity: 0.95;
                    pointer-events: none;
                    z-index: 99999;
                `;
                
                document.body.appendChild(dragImage);
                
                // 同期的にsetDragImageを呼び出す
                e.dataTransfer.setDragImage(dragImage, button.offsetWidth / 2, button.offsetHeight / 2);
                
                // ドラッグ開始後に削除
                setTimeout(() => {
                    dragImage.remove();
                }, 100);
            });

            button.addEventListener('drag', (e) => {
                // ドラッグ中の自動スクロール
                if (e.clientY > 0) {
                    startAutoScroll(e.clientY);
                }
            });

            button.addEventListener('dragend', () => {
                button.classList.remove('dragging');
                stopAutoScroll();
            });

            button.addEventListener('dragover', (e) => {
                if (!document.body.classList.contains('sort-mode')) return;
                const draggingElement = document.querySelector('.dragging');
                // 音声ボタン同士のドラッグのみ許可（カテゴリボックスは除外）
                if (!draggingElement || draggingElement.classList.contains('category-box')) return;
                e.preventDefault();
                e.stopPropagation(); // イベント伝播を止める
                e.dataTransfer.dropEffect = 'move';
                button.classList.add('drag-over');
            });

            button.addEventListener('dragleave', (e) => {
                // 子要素への移動を無視（誤ってdrag-overを外さない）
                const rect = button.getBoundingClientRect();
                const x = e.clientX;
                const y = e.clientY;
                
                if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
                    button.classList.remove('drag-over');
                }
            });

            button.addEventListener('drop', (e) => {
                if (!document.body.classList.contains('sort-mode')) return;
                e.preventDefault();
                e.stopPropagation();
                button.classList.remove('drag-over');
                
                const draggingElement = document.querySelector('.dragging');
                if (draggingElement && draggingElement !== button && draggingElement.classList.contains('sound-btn')) {
                    const parent = button.parentNode;
                    const allButtons = Array.from(parent.querySelectorAll('.sound-btn'));
                    const dragIndex = allButtons.indexOf(draggingElement);
                    const dropIndex = allButtons.indexOf(button);
                    
                    // シンプルな位置入れ替え
                    if (dragIndex < dropIndex) {
                        parent.insertBefore(draggingElement, button.nextSibling);
                    } else {
                        parent.insertBefore(draggingElement, button);
                    }
                    
                    // カスタムソート順を保存
                    saveCustomOrder();
                }
            });

            const volumeSlider = button.querySelector('.volume-slider');
            volumeSlider.addEventListener('input', (e) => {
                const newVolume = parseFloat(e.target.value);
                sendCommand({ action: 'update_setting', soundId: sound.id, setting: 'volume', value: newVolume });
            });

            button.querySelectorAll('.color-swatch').forEach(swatch => {
                swatch.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const newColor = e.target.dataset.color;
                    sendCommand({ action: 'update_setting', soundId: sound.id, setting: 'color', value: newColor });
                });
            });

            return button;
        };

        // ソート関数
        const sortSounds = (soundsArray, sortBy, sortOrder, customOrder = []) => {
            // カスタムソートの場合
            if (sortBy === 'custom') {
                if (customOrder.length === 0) {
                    // カスタムオーダーが未設定の場合は名前順をデフォルトに
                    console.log('カスタムオーダーが未設定のため、名前順でソートします');
                    return sortSounds(soundsArray, 'name', 'asc', []);
                }
                
                return soundsArray.sort((a, b) => {
                    const indexA = customOrder.indexOf(a.id);
                    const indexB = customOrder.indexOf(b.id);
                    
                    // 両方がカスタムオーダーに含まれていない場合は名前順
                    if (indexA === -1 && indexB === -1) {
                        return a.name.localeCompare(b.name, 'ja');
                    }
                    // カスタムオーダーに含まれていない場合は最後に配置
                    if (indexA === -1) return 1;
                    if (indexB === -1) return -1;
                    return indexA - indexB;
                });
            }
            
            // 名前順またはカテゴリ順
            return soundsArray.sort((a, b) => {
                let compareA, compareB;
                
                if (sortBy === 'category') {
                    // カテゴリ名で比較、カテゴリなしは最後
                    compareA = a.category || 'zzz_未分類';
                    compareB = b.category || 'zzz_未分類';
                    
                    // カテゴリが同じ場合は名前でソート
                    if (compareA === compareB) {
                        compareA = a.name;
                        compareB = b.name;
                    }
                } else { // sortBy === 'name'
                    compareA = a.name;
                    compareB = b.name;
                }
                
                // 日本語対応のソート
                const comparison = compareA.localeCompare(compareB, 'ja', { 
                    numeric: true,
                    sensitivity: 'base'
                });
                
                return sortOrder === 'asc' ? comparison : -comparison;
            });
        };

        // サウンドボードの描画
        const renderSoundBoard = (data, sortBy = 'name', sortOrder = 'asc', customOrder = [], customCategoryOrder = []) => {
            console.log('renderSoundBoard called with:', { data, sortBy, sortOrder, customCategoryOrder });
            soundBoard.innerHTML = '';
            
            // 全てのサウンドを配列に変換
            const allSounds = [];
            
            // カテゴリ内のファイル
            Object.keys(data.categories || {}).forEach(category => {
                console.log(`Processing category: ${category}`, data.categories[category]);
                data.categories[category].forEach(fileInfo => {
                    allSounds.push({
                        id: `sound-${encodeURIComponent(category)}-${encodeURIComponent(fileInfo.name)}`,
                        name: fileInfo.name,
                        category: category
                    });
                });
            });
            
            // ルートディレクトリのファイル
            (data.files || []).forEach(fileInfo => {
                console.log(`Processing root file:`, fileInfo);
                allSounds.push({
                    id: `sound-${encodeURIComponent(fileInfo.name)}`,
                    name: fileInfo.name,
                    category: null
                });
            });
            
            console.log('All sounds:', allSounds);
            
            // ソート
            const sortedSounds = sortSounds(allSounds, sortBy, sortOrder, customOrder);
            
            // カスタムソートまたは名前ソートの場合はフラット表示
            if (sortBy === 'custom' || sortBy === 'name') {
                sortedSounds.forEach(sound => {
                    const button = createButton(sound);
                    soundBoard.appendChild(button);
                });
                return;
            }
            
            // カテゴリごとにグループ化して表示
            if (sortBy === 'category') {
                let currentCategory = undefined;
                let categoryBox = null;
                let categoryContent = null;
                
                // カテゴリごとのDOM要素を一時保存（カスタム順序適用用）
                const categoryElements = [];
                
                sortedSounds.forEach(sound => {
                    // カテゴリが変わった、または初回の場合
                    if (sound.category !== currentCategory) {
                        currentCategory = sound.category;
                        
                        // カテゴリボックス（外側のコンテナ）を作成
                        categoryBox = document.createElement('div');
                        categoryBox.className = 'category-box';
                        categoryBox.dataset.category = encodeURIComponent(currentCategory || 'other');
                        
                        // カテゴリヘッダーを作成
                        const categoryHeader = document.createElement('div');
                        categoryHeader.className = 'category-header';
                        
                        const checkbox = document.createElement('input');
                        checkbox.type = 'checkbox';
                        checkbox.checked = true;
                        const categoryId = currentCategory || 'other';
                        checkbox.id = `category-${encodeURIComponent(categoryId)}`;
                        
                        const label = document.createElement('label');
                        label.textContent = currentCategory || 'その他';
                        label.style.cursor = 'pointer';
                        label.style.flexGrow = '1';
                        
                        categoryHeader.appendChild(checkbox);
                        categoryHeader.appendChild(label);
                        
                        // カテゴリコンテンツを作成
                        categoryContent = document.createElement('div');
                        categoryContent.className = 'category-content';
                        categoryContent.dataset.category = encodeURIComponent(categoryId);
                        
                        // ボックスにヘッダーとコンテンツを追加
                        categoryBox.appendChild(categoryHeader);
                        categoryBox.appendChild(categoryContent);
                        
                        // サウンドボードに追加
                        soundBoard.appendChild(categoryBox);
                        
                        // カテゴリ要素を保存（後でカスタム順序適用用）
                        categoryElements.push({
                            categoryName: currentCategory || 'other',
                            box: categoryBox
                        });
                        
                        // カテゴリボックスのドラッグ&ドロップ設定
                        categoryBox.setAttribute('draggable', 'false'); // 初期状態では無効
                        
                        categoryBox.addEventListener('dragstart', (e) => {
                            if (!document.body.classList.contains('sort-mode')) {
                                e.preventDefault();
                                return;
                            }
                            
                            categoryBox.classList.add('dragging');
                            e.dataTransfer.effectAllowed = 'move';
                            e.dataTransfer.setData('category-id', categoryBox.dataset.category);
                            
                            // 既存の全てのドラッグ画像を確実に削除
                            document.querySelectorAll('.temp-drag-image').forEach(img => {
                                img.remove();
                            });
                            
                            // シンプルなドラッグ画像を作成（カテゴリ名のみ表示）
                            const categoryName = currentCategory || 'その他';
                            const dragImage = document.createElement('div');
                            dragImage.className = 'temp-drag-image';
                            dragImage.textContent = `📁 ${categoryName}`;
                            dragImage.style.cssText = `
                                position: absolute;
                                top: -10000px;
                                left: -10000px;
                                width: ${categoryBox.offsetWidth}px;
                                min-height: 60px;
                                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                                color: white;
                                display: flex;
                                align-items: center;
                                justify-content: center;
                                border-radius: 12px;
                                font-size: 18px;
                                font-weight: 600;
                                box-shadow: 0 8px 16px rgba(0,0,0,0.3);
                                opacity: 0.95;
                                pointer-events: none;
                                z-index: 99999;
                                padding: 10px;
                            `;
                            
                            document.body.appendChild(dragImage);
                            
                            // 同期的にsetDragImageを呼び出す
                            e.dataTransfer.setDragImage(dragImage, categoryBox.offsetWidth / 2, 30);
                            
                            // ドラッグ開始後に削除
                            setTimeout(() => {
                                dragImage.remove();
                            }, 100);
                        });
                        
                        categoryBox.addEventListener('drag', (e) => {
                            // ドラッグ中の自動スクロール
                            if (e.clientY > 0) {
                                startAutoScroll(e.clientY);
                            }
                        });
                        
                        categoryBox.addEventListener('dragend', () => {
                            categoryBox.classList.remove('dragging');
                            stopAutoScroll();
                        });
                        
                        categoryBox.addEventListener('dragover', (e) => {
                            if (!document.body.classList.contains('sort-mode')) return;
                            const draggingElement = document.querySelector('.category-box.dragging');
                            // カテゴリボックスがドラッグされている場合
                            if (!draggingElement) return;
                            
                            // 常にデフォルトの動作を防ぐ（禁止カーソルを防ぐ）
                            e.preventDefault();
                            e.stopPropagation();
                            
                            // 自分自身以外の場合のみdrag-overスタイルを適用
                            if (draggingElement !== categoryBox) {
                                e.dataTransfer.dropEffect = 'move';
                                categoryBox.classList.add('drag-over');
                            } else {
                                e.dataTransfer.dropEffect = 'move';
                            }
                        });
                        
                        categoryBox.addEventListener('dragleave', (e) => {
                            // 子要素への移動を無視（境界チェック）
                            const rect = categoryBox.getBoundingClientRect();
                            const x = e.clientX;
                            const y = e.clientY;
                            
                            if (x < rect.left || x >= rect.right || y < rect.top || y >= rect.bottom) {
                                categoryBox.classList.remove('drag-over');
                            }
                        });
                        
                        categoryBox.addEventListener('drop', (e) => {
                            if (!document.body.classList.contains('sort-mode')) return;
                            e.preventDefault();
                            e.stopPropagation();
                            categoryBox.classList.remove('drag-over');
                            
                            const draggingBox = document.querySelector('.category-box.dragging');
                            if (draggingBox && draggingBox !== categoryBox && draggingBox.classList.contains('category-box')) {
                                // シンプルな位置入れ替え
                                soundBoard.insertBefore(draggingBox, categoryBox);
                                
                                // カスタムカテゴリ順を保存
                                saveCustomCategoryOrder();
                            }
                        });
                        
                        // チェックボックスの動作
                        checkbox.addEventListener('change', (e) => {
                            if (e.target.checked) {
                                categoryContent.classList.remove('collapsed');
                            } else {
                                categoryContent.classList.add('collapsed');
                            }
                        });
                        
                        // ヘッダー全体クリックでトグル（ドラッグ中は無効）
                        categoryHeader.addEventListener('click', (e) => {
                            if (e.target !== checkbox && !document.body.classList.contains('sort-mode')) {
                                checkbox.checked = !checkbox.checked;
                                checkbox.dispatchEvent(new Event('change'));
                            }
                        });
                    }
                    
                    // categoryContentが存在することを確認してからボタンを追加
                    if (categoryContent) {
                        const button = createButton(sound);
                        categoryContent.appendChild(button);
                    } else {
                        console.error('categoryContent is null for sound:', sound);
                    }
                });
                
                // カスタムカテゴリ順で並び替え（既にDOMに追加済みなので再配置）
                if (customCategoryOrder.length > 0) {
                    // カスタム順序に従ってカテゴリを並び替え
                    const sortedCategories = categoryElements.sort((a, b) => {
                        const indexA = customCategoryOrder.indexOf(a.categoryName);
                        const indexB = customCategoryOrder.indexOf(b.categoryName);
                        // カスタムオーダーに含まれていない場合は最後に配置
                        if (indexA === -1 && indexB === -1) return 0;
                        if (indexA === -1) return 1;
                        if (indexB === -1) return -1;
                        return indexA - indexB;
                    });
                    
                    // 並び替えた順序でDOMを再配置
                    sortedCategories.forEach(({ box }) => {
                        soundBoard.appendChild(box);
                    });
                }
            } else {
                // 名前順の場合はカテゴリヘッダーなし
                sortedSounds.forEach(sound => {
                    soundBoard.appendChild(createButton(sound));
                });
            }
            
            // Apply initial settings once buttons are created
            applyAllSettings(globalSettings);
        };

        // soundBoard全体のドラッグ&ドロップイベント（カテゴリボックスのドラッグを許可）
        soundBoard.addEventListener('dragover', (e) => {
            const draggingBox = document.querySelector('.category-box.dragging');
            if (draggingBox) {
                // カテゴリボックスのドラッグを許可
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            }
        });

        soundBoard.addEventListener('drop', (e) => {
            const draggingBox = document.querySelector('.category-box.dragging');
            if (draggingBox) {
                // soundBoard直下へのドロップは何もしない（カテゴリボックス同士のdropイベントで処理）
                e.preventDefault();
            }
        });

        stopAllBtn.addEventListener('click', () => sendCommand({ action: 'stopAll' }));

        masterVolumeSlider.addEventListener('input', (e) => {
            const newMasterVolume = parseFloat(e.target.value);
            sendCommand({ action: 'update_setting', setting: 'masterVolume', value: newMasterVolume });
        });

        columnsInput.addEventListener('change', (e) => {
            const newColumns = parseInt(e.target.value, 10);
            sendCommand({ action: 'update_setting', setting: 'columns', value: newColumns });
            // カテゴリコンテンツにもカラム数を適用
            document.querySelectorAll('.category-content').forEach(content => {
                content.style.setProperty('--columns', newColumns);
            });
        });

        volumeModeBtn.addEventListener('click', () => {
            document.body.classList.toggle('volume-adjust-mode');
            const isAdjustMode = document.body.classList.contains('volume-adjust-mode');
            volumeModeBtn.textContent = isAdjustMode ? '🔊 調整中...' : '🔊 音量調整';
            volumeModeBtn.style.backgroundColor = isAdjustMode ? '#007bff' : '';
            
            // 並び替えモードを解除
            if (isAdjustMode && document.body.classList.contains('sort-mode')) {
                document.body.classList.remove('sort-mode');
                const sortModeBtn = document.getElementById('sort-mode-btn');
                if (sortModeBtn) {
                    sortModeBtn.textContent = '🔀 並び替え';
                    sortModeBtn.style.backgroundColor = '';
                }
                document.querySelectorAll('.sound-btn').forEach(btn => {
                    btn.setAttribute('draggable', 'false');
                });
            }
        });

        // 並び替えモードボタン
        const sortModeBtn = document.getElementById('sort-mode-btn');
        if (sortModeBtn) {
            sortModeBtn.addEventListener('click', () => {
                document.body.classList.toggle('sort-mode');
                const isSortMode = document.body.classList.contains('sort-mode');
                sortModeBtn.textContent = isSortMode ? '🔒 ロック解除中' : '🔀 並び替え';
                sortModeBtn.style.backgroundColor = isSortMode ? '#28a745' : '';
                
                if (isSortMode) {
                    const currentSortBy = globalSettings.sortBy || 'name';
                    if (currentSortBy === 'custom') {
                        showNotification('✨ ドラッグして並び替えできます\n順序は自動保存されます', 'info', 3000);
                    } else {
                        showNotification('💡 カスタム順にすると自由に配置できます\n(設定から変更)', 'info', 4000);
                    }
                }
                
                // ドラッグ可能状態を切り替え（サウンドボタン）
                const soundButtons = document.querySelectorAll('.sound-btn');
                soundButtons.forEach(btn => {
                    btn.setAttribute('draggable', isSortMode ? 'true' : 'false');
                });
                
                // ドラッグ可能状態を切り替え（カテゴリボックス）
                const categoryBoxes = document.querySelectorAll('.category-box');
                categoryBoxes.forEach(box => {
                    box.setAttribute('draggable', isSortMode ? 'true' : 'false');
                });
                
                // 音量調整モードを解除
                if (isSortMode && document.body.classList.contains('volume-adjust-mode')) {
                    document.body.classList.remove('volume-adjust-mode');
                    volumeModeBtn.textContent = '🔊 音量調整';
                    volumeModeBtn.style.backgroundColor = '';
                }
            });
        }

        // カスタムソート順を保存
        const saveCustomOrder = () => {
            const buttons = Array.from(soundBoard.querySelectorAll('.sound-btn'));
            const customOrder = buttons.map(btn => btn.dataset.id);
            sendCommand({ action: 'update_setting', setting: 'customOrder', value: customOrder });
            showNotification('💾 並び順を保存しました', 'success', 2000);
        };

        // カスタムカテゴリ順を保存
        const saveCustomCategoryOrder = () => {
            const boxes = Array.from(soundBoard.querySelectorAll('.category-box'));
            const customCategoryOrder = boxes.map(box => decodeURIComponent(box.dataset.category));
            sendCommand({ action: 'update_setting', setting: 'customCategoryOrder', value: customCategoryOrder });
            showNotification('💾 カテゴリの並び順を保存しました', 'success', 2000);
        };

        // 設定値をモーダルに読み込む
        const loadSettingsToModal = () => {
            // カラム数
            if (columnsInput && globalSettings.columns) {
                columnsInput.value = globalSettings.columns;
            }
            
            // 並び順
            if (sortBySelect && globalSettings.sortBy) {
                sortBySelect.value = globalSettings.sortBy;
                // 並び順に応じて昇順/降順の表示を更新
                updateSortOrderVisibility(globalSettings.sortBy);
            }
            
            // 昇順/降順
            if (sortOrderSelect && globalSettings.sortOrder) {
                sortOrderSelect.value = globalSettings.sortOrder;
            }
            
            // リモート再生設定
            const playOnRemoteCheckbox = document.getElementById('play-on-remote-checkbox');
            if (playOnRemoteCheckbox) {
                playOnRemoteCheckbox.checked = globalSettings.playOnRemote !== false;
            }
        };

        // カラム数の変更を即座に反映
        if (columnsInput) {
            columnsInput.addEventListener('input', (e) => {
                const newColumns = parseInt(e.target.value);
                if (newColumns >= 1 && newColumns <= 10) {
                    soundBoard.style.gridTemplateColumns = `repeat(${newColumns}, 1fr)`;
                    globalSettings.columns = newColumns;
                    sendCommand({ action: 'update_setting', setting: 'columns', value: newColumns });
                    showNotification(`カラム数を ${newColumns} に変更しました`, 'success', 2000);
                }
            });
        }

        // 設定モーダルを開く時に現在の値を反映
        settingsBtn.addEventListener('click', () => {
            modal.style.display = 'block';
            loadSettingsToModal();
        });
        
        closeBtn.addEventListener('click', () => {
            modal.style.display = 'none';
        });
        
        window.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        });

        // ソート設定の変更
        const sortBySelect = document.getElementById('sort-by');
        const sortOrderSelect = document.getElementById('sort-order');
        const sortOrderWrapper = document.querySelector('.sort-order-wrapper');
        
        let soundsData = null;
        
        // 並び順に応じて昇順/降順の表示を切り替え
        const updateSortOrderVisibility = (sortBy) => {
            if (sortOrderWrapper) {
                // カスタム順の場合は昇順/降順を非表示
                if (sortBy === 'custom') {
                    sortOrderWrapper.style.display = 'none';
                } else {
                    sortOrderWrapper.style.display = 'flex';
                }
            }
        };
        
        if (sortBySelect) {
            sortBySelect.addEventListener('change', (e) => {
                const newSortBy = e.target.value;
                globalSettings.sortBy = newSortBy;
                sendCommand({ action: 'update_setting', setting: 'sortBy', value: newSortBy });
                
                // 昇順/降順の表示を更新
                updateSortOrderVisibility(newSortBy);
                
                // 通知メッセージを詳しく
                let message = `並び順を「${getSortByLabel(newSortBy)}」に変更しました`;
                if (newSortBy === 'custom') {
                    message += '\n並び替えモードで順序を変更できます';
                }
                showNotification(message, 'success', 3000);
                
                if (soundsData) {
                    const sortOrder = sortOrderSelect ? sortOrderSelect.value : 'asc';
                    const customOrder = globalSettings.customOrder || [];
                    const customCategoryOrder = globalSettings.customCategoryOrder || [];
                    renderSoundBoard(soundsData, newSortBy, sortOrder, customOrder, customCategoryOrder);
                }
            });
        }
        
        if (sortOrderSelect) {
            sortOrderSelect.addEventListener('change', (e) => {
                const newSortOrder = e.target.value;
                globalSettings.sortOrder = newSortOrder;
                sendCommand({ action: 'update_setting', setting: 'sortOrder', value: newSortOrder });
                showNotification(`${newSortOrder === 'asc' ? '昇順 (A→Z)' : '降順 (Z→A)'}に変更しました`, 'success', 2000);
                if (soundsData) {
                    const sortBy = sortBySelect ? sortBySelect.value : 'name';
                    const customOrder = globalSettings.customOrder || [];
                    const customCategoryOrder = globalSettings.customCategoryOrder || [];
                    renderSoundBoard(soundsData, sortBy, newSortOrder, customOrder, customCategoryOrder);
                }
            });
        }
        
        // ソート方法のラベルを取得
        const getSortByLabel = (sortBy) => {
            switch(sortBy) {
                case 'name': return '名前順';
                case 'category': return 'カテゴリ順';
                case 'custom': return 'カスタム';
                default: return sortBy;
            }
        };
        
        // リモート再生設定の変更
        const playOnRemoteCheckbox = document.getElementById('play-on-remote-checkbox');
        if (playOnRemoteCheckbox) {
            playOnRemoteCheckbox.addEventListener('change', (e) => {
                const playOnRemote = e.target.checked;
                globalSettings.playOnRemote = playOnRemote;
                sendCommand({ action: 'update_setting', setting: 'playOnRemote', value: playOnRemote });
                showNotification(`リモート再生を${playOnRemote ? '有効' : '無効'}にしました`, 'success', 2000);
            });
        }

        fetch('/sounds').then(res => res.json()).then(data => {
            soundsData = data;
            
            // 設定を読み込んでから描画
            fetch('/api/settings').then(res => res.json()).then(settings => {
                globalSettings = settings;
                const sortBy = settings.sortBy || 'name';
                const sortOrder = settings.sortOrder || 'asc';
                const customOrder = settings.customOrder || [];
                const customCategoryOrder = settings.customCategoryOrder || [];
                
                if (sortBySelect) sortBySelect.value = sortBy;
                if (sortOrderSelect) sortOrderSelect.value = sortOrder;
                
                renderSoundBoard(data, sortBy, sortOrder, customOrder, customCategoryOrder);
            }).catch(err => {
                console.error('Failed to load settings:', err);
                // デフォルト値で描画
                renderSoundBoard(data, 'name', 'asc', [], []);
            });
        }).catch(err => {
            console.error('Failed to load sounds:', err);
        });
    }

    // --- Main Execution ---
    if (isObs) {
        console.log('Running in OBS mode. UI is hidden.');
        if (container) container.style.display = 'none';
        initializeAudioEngine();
    } else {
        console.log('Running in Remote Control mode.');
        initializeRemoteUI();
    }
    connectWebSocket();
});
