import React, { useState, useEffect, useRef, useCallback } from 'react';

declare global {
    interface Window {
        electron: {
            send: (channel: string, data?: any) => void;
            on: (channel: string, func: (...args: any[]) => void) => void;
            invoke: (channel: string, data?: any) => Promise<any>;
        };
    }
}

interface AccountRow {
    email: string;
    password: string;
    status: 'pending' | 'running' | 'done' | 'error';
    statusText?: string;
}

interface SavedContact {
    number: string;
    label: string;
}

interface CookieAccountRow {
    id: string;         // c_user value
    cookieStr: string;  // raw cookie string
    status: 'pending' | 'running' | 'done' | 'error';
    statusText?: string;
}

const App = () => {
    // --- Single Account Settings ---
    const [city, setCity] = useState('Tulungagung');
    const [radius, setRadius] = useState(1);
    const [keyword, setKeyword] = useState('');
    const [captionKeyword, setCaptionKeyword] = useState('');
    const [boostCount, setBoostCount] = useState(10);

    // --- Facebook Search (opsional) ---
    const [fbKeyword, setFbKeyword] = useState('');
    const [searchOrder, setSearchOrder] = useState<'keyword_first' | 'fb_first'>('keyword_first');

    // --- CSV Import ---
    const [accounts, setAccounts] = useState<AccountRow[]>([]);
    const [concurrentLimit, setConcurrentLimit] = useState(2);
    const [csvLocations, setCsvLocations] = useState('Tulungagung');
    const [campaignRunning, setCampaignRunning] = useState(false);
    const [gmailOnly, setGmailOnly] = useState(false);
    const [skipFailedLogin, setSkipFailedLogin] = useState(true);
    const [cookieInput, setCookieInput] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);

    // --- Cookie Campaign ---
    const [cookieCampaignInput, setCookieCampaignInput] = useState('');
    const [cookieAccounts, setCookieAccounts] = useState<CookieAccountRow[]>([]);
    const [cookieCampaignRunning, setCookieCampaignRunning] = useState(false);

    // --- Hamburger Menu / Updater ---
    const [menuOpen, setMenuOpen] = useState(false);
    const [appVersion, setAppVersion] = useState('...');
    const [updateInfo, setUpdateInfo] = useState<any>(null);
    const [updateStatus, setUpdateStatus] = useState<string>('');
    const [isChecking, setIsChecking] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);
    const [updateReady, setUpdateReady] = useState(false);
    const menuRef = useRef<HTMLDivElement>(null);

    // --- Saved Contacts ---
    const [savedContacts, setSavedContacts] = useState<SavedContact[]>([]);
    const [newContactNumber, setNewContactNumber] = useState('');
    const [newContactLabel, setNewContactLabel] = useState('');

    // --- Logs & Status ---
    const [logs, setLogs] = useState<string[]>([]);
    const [status, setStatus] = useState('Idle');

    // Load saved contacts from localStorage on mount
    useEffect(() => {
        try {
            const stored = localStorage.getItem('botting_saved_contacts');
            if (stored) setSavedContacts(JSON.parse(stored));
        } catch { /* ignore */ }
    }, []);

    // Persist contacts to localStorage
    const persistContacts = useCallback((contacts: SavedContact[]) => {
        setSavedContacts(contacts);
        localStorage.setItem('botting_saved_contacts', JSON.stringify(contacts));
    }, []);

    const handleSaveContact = () => {
        const num = newContactNumber.trim();
        if (!num) return;
        if (savedContacts.some(c => c.number === num)) return; // no duplicates
        const updated = [...savedContacts, { number: num, label: newContactLabel.trim() }];
        persistContacts(updated);
        setNewContactNumber('');
        setNewContactLabel('');
    };

    const handleDeleteContact = (number: string) => {
        persistContacts(savedContacts.filter(c => c.number !== number));
    };

    const handleLoadContact = (number: string) => {
        setCaptionKeyword(number);
    };

    useEffect(() => {
        if (window.electron) {
            window.electron.on('log-message', (msg: string) => {
                setLogs(prev => [...prev.slice(-49), msg]);
            });
            window.electron.on('status-update', (msg: string) => {
                setStatus(msg);
            });
            window.electron.on('account-status', (data: { email: string; status: AccountRow['status']; text?: string }) => {
                // Update CSV campaign accounts
                setAccounts(prev => prev.map(a =>
                    a.email === data.email
                        ? { ...a, status: data.status, statusText: data.text }
                        : a
                ));
                // Update Cookie campaign accounts (label = cookie_<c_user>)
                setCookieAccounts(prev => prev.map(a =>
                    `cookie_${a.id}` === data.email
                        ? { ...a, status: data.status, statusText: data.text }
                        : a
                ));
            });
            window.electron.on('campaign-done', () => {
                setCampaignRunning(false);
                setCookieCampaignRunning(false);
                setStatus('Campaign selesai.');
            });
            // Update events
            window.electron.on('update-status', (data: any) => {
                if (data.type === 'check-result') {
                    setUpdateInfo(data);
                    setIsChecking(false);
                    setUpdateStatus(data.hasUpdate ? '🆕 Update tersedia!' : '✅ Sudah versi terbaru');
                } else if (data.type === 'downloading') {
                    setIsDownloading(true);
                    setUpdateStatus('⬇️ Downloading update...');
                } else if (data.type === 'done') {
                    setIsDownloading(false);
                    setUpdateStatus('✅ Update selesai! Klik tombol Restart.');
                    setUpdateReady(true);
                } else if (data.type === 'error') {
                    setIsChecking(false);
                    setIsDownloading(false);
                    setUpdateStatus(`❌ Error: ${data.message}`);
                }
            });
            // Fetch version
            window.electron.invoke('get-version').then(v => setAppVersion(v)).catch(() => {});
        }
    }, []);

    // Close hamburger on click outside
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
                setMenuOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // --- Validation ---
    const canStart = keyword.trim() !== '' && captionKeyword.trim() !== '';
    const showFbOrder = fbKeyword.trim() !== '';

    // --- Handlers: Single Account ---
    const handleLogin = () => {
        if (window.electron) {
            window.electron.send('login-manual');
            setStatus('Manual Login Initiated...');
        }
    };

    const handleCookieLogin = () => {
        if (!cookieInput.trim()) return;
        if (window.electron) {
            window.electron.send('login-cookies', { cookies: cookieInput });
            setStatus('🍪 Cookie Login...');
        }
    };

    const handleStart = () => {
        if (!canStart) return;
        if (window.electron) {
            const cities = city.split(',').map(s => s.trim()).filter(Boolean);
            const config = { cities, radius, keyword, captionKeyword, boostCount, fbKeyword: fbKeyword.trim() || undefined, searchOrder, skipFailedLogin };
            window.electron.send('start-boost', config);
            setStatus(`Running: "${keyword}" → cari "${captionKeyword}" @ ${cities.join(', ')} (${boostCount} cycles)`);
        }
    };

    const handleScrape = () => {
        if (window.electron) {
            const cities = city.split(',').map(s => s.trim()).filter(Boolean);
            window.electron.send('start-scrape', { cities, radius });
            setStatus(`Scraping: ${cities.join(', ')}...`);
        }
    };

    // --- Handler: CSV Import ---
    const handleCsvFile = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            const text = ev.target?.result as string;
            const lines = text.split(/\r?\n/);
            const parsed: AccountRow[] = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.toLowerCase().startsWith('password')) continue;
                const parts = trimmed.split(';');
                if (parts.length < 2) continue;
                const password = parts[0].trim();
                const email = parts[1].trim();
                if (!email || !password || !email.includes('@')) continue;
                if (gmailOnly && !email.toLowerCase().endsWith('@gmail.com')) continue;
                parsed.push({ email, password, status: 'pending' });
            }
            setAccounts(parsed);
            setStatus(`✅ ${parsed.length} akun berhasil di-import${gmailOnly ? ' (hanya @gmail.com)' : ''}.`);
        };
        reader.readAsText(file);
        e.target.value = '';
    };

    const handleRunCampaign = () => {
        if (!accounts.length || !canStart) return;
        if (!window.electron) return;
        const cities = csvLocations.split(',').map(s => s.trim()).filter(Boolean);
        setAccounts(prev => prev.map(a => ({ ...a, status: 'pending', statusText: undefined })));
        setCampaignRunning(true);
        window.electron.send('run-csv-campaign', {
            accounts: accounts.map(a => ({ email: a.email, password: a.password })),
            cities,
            radius,
            keyword,
            captionKeyword,
            boostCount,
            fbKeyword: fbKeyword.trim() || undefined,
            searchOrder,
            concurrentLimit,
            skipFailedLogin,
        });
        setStatus(`🚀 Menjalankan ${accounts.length} akun (${concurrentLimit} bersamaan)...`);
    };

    const statusColor = (s: AccountRow['status']) => {
        if (s === 'done') return '#4CAF50';
        if (s === 'running') return '#FFC107';
        if (s === 'error') return '#f44336';
        return '#888';
    };

    // --- Handlers: Cookie Campaign ---
    const handleParseCookies = () => {
        const lines = cookieCampaignInput.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        const parsed: CookieAccountRow[] = [];
        for (const line of lines) {
            // Extract c_user value for ID
            const match = line.match(/c_user[=:]\s*(\d+)/);
            const id = match ? match[1] : `unknown_${parsed.length + 1}`;
            parsed.push({ id, cookieStr: line, status: 'pending' });
        }
        setCookieAccounts(parsed);
        setStatus(`✅ ${parsed.length} akun cookie berhasil di-parse.`);
    };

    const handleRunCookieCampaign = () => {
        if (!cookieAccounts.length || !canStart) return;
        if (!window.electron) return;
        const cities = csvLocations.split(',').map(s => s.trim()).filter(Boolean);
        setCookieAccounts(prev => prev.map(a => ({ ...a, status: 'pending', statusText: undefined })));
        setCookieCampaignRunning(true);
        window.electron.send('run-cookie-campaign', {
            cookieAccounts: cookieAccounts.map(a => a.cookieStr),
            cities,
            radius,
            keyword,
            captionKeyword,
            boostCount,
            fbKeyword: fbKeyword.trim() || undefined,
            searchOrder,
            concurrentLimit,
        });
        setStatus(`🍪 Menjalankan ${cookieAccounts.length} akun cookie (${concurrentLimit} bersamaan)...`);
    };

    return (
        <div style={{ padding: '20px', maxWidth: '860px', margin: '0 auto', fontFamily: 'sans-serif', color: '#eee', background: '#1a1a1a', minHeight: '100vh' }}>
            {/* === Header with Hamburger === */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '2px solid #333', paddingBottom: '10px', position: 'relative' }}>
                <h1 style={{ margin: 0 }}>🤖 Botting Dashboard</h1>
                <div ref={menuRef} style={{ position: 'relative' }}>
                    <button
                        onClick={() => setMenuOpen(!menuOpen)}
                        style={{ background: 'none', border: '1px solid #555', borderRadius: '6px', color: '#eee', fontSize: '22px', cursor: 'pointer', padding: '4px 10px', lineHeight: 1 }}
                    >
                        ☰
                    </button>
                    {menuOpen && (
                        <div style={{
                            position: 'absolute', right: 0, top: '100%', marginTop: '8px',
                            background: '#1e1e2e', border: '1px solid #444', borderRadius: '10px',
                            padding: '16px', width: '320px', zIndex: 999,
                            boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                        }}>
                            {/* Version */}
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                                <span style={{ fontSize: '14px', fontWeight: 'bold', color: '#ccc' }}>📦 Versi Aplikasi</span>
                                <span style={{ fontSize: '13px', color: '#FF9800', fontFamily: 'monospace', background: '#2a2a2a', padding: '2px 8px', borderRadius: '4px' }}>v{appVersion}</span>
                            </div>

                            <hr style={{ border: 'none', borderTop: '1px solid #333', margin: '10px 0' }} />

                            {/* Check for update */}
                            <button
                                onClick={() => {
                                    setIsChecking(true);
                                    setUpdateStatus('🔍 Checking...');
                                    setUpdateInfo(null);
                                    window.electron?.send('check-update');
                                }}
                                disabled={isChecking || isDownloading}
                                style={{
                                    ...btnStyle(isChecking || isDownloading ? '#444' : '#2196F3'),
                                    width: '100%', fontSize: '13px', padding: '8px',
                                    cursor: isChecking || isDownloading ? 'not-allowed' : 'pointer',
                                    opacity: isChecking || isDownloading ? 0.6 : 1,
                                }}
                            >
                                {isChecking ? '⏳ Checking...' : '🔄 Check for Updates'}
                            </button>

                            {/* Status */}
                            {updateStatus && (
                                <p style={{ fontSize: '12px', color: '#aaa', margin: '8px 0 0 0', textAlign: 'center' }}>{updateStatus}</p>
                            )}

                            {/* Update info */}
                            {updateReady ? (
                                <div style={{ marginTop: '12px', padding: '10px', background: '#1a2a1a', borderRadius: '8px', border: '1px solid #2d5a2d' }}>
                                    <p style={{ margin: '0 0 6px 0', fontSize: '13px', color: '#4CAF50', fontWeight: 'bold', textAlign: 'center' }}>
                                        ✅ Update siap diterapkan!
                                    </p>
                                    <button
                                        onClick={() => window.electron?.send('relaunch-app')}
                                        style={{
                                            background: '#4CAF50', color: 'white', border: 'none', borderRadius: '4px',
                                            width: '100%', fontSize: '13px', padding: '8px', cursor: 'pointer'
                                        }}
                                    >
                                        🔄 Restart Sekarang
                                    </button>
                                </div>
                            ) : updateInfo?.hasUpdate && (
                                <div style={{ marginTop: '12px', padding: '10px', background: '#1a2a1a', borderRadius: '8px', border: '1px solid #2d5a2d' }}>
                                    <p style={{ margin: '0 0 6px 0', fontSize: '13px', color: '#4CAF50', fontWeight: 'bold' }}>
                                        🆕 v{updateInfo.latestVersion} tersedia!
                                    </p>
                                    {updateInfo.releaseNotes && (
                                        <p style={{ margin: '0 0 8px 0', fontSize: '11px', color: '#888', maxHeight: '80px', overflowY: 'auto' }}>
                                            {updateInfo.releaseNotes.substring(0, 200)}
                                        </p>
                                    )}
                                    <button
                                        onClick={() => {
                                            window.electron?.send('run-update', { downloadUrl: updateInfo.downloadUrl });
                                        }}
                                        disabled={isDownloading}
                                        style={{
                                            ...btnStyle(isDownloading ? '#444' : '#4CAF50'),
                                            width: '100%', fontSize: '13px', padding: '8px',
                                            cursor: isDownloading ? 'not-allowed' : 'pointer',
                                            opacity: isDownloading ? 0.6 : 1,
                                        }}
                                    >
                                        {isDownloading ? '⬇️ Downloading...' : '⬇️ Download & Install'}
                                    </button>
                                </div>
                            )}

                            <hr style={{ border: 'none', borderTop: '1px solid #333', margin: '12px 0 8px 0' }} />
                            <p style={{ margin: 0, fontSize: '11px', color: '#555', textAlign: 'center' }}>Botting v{appVersion} • Made with ❤️</p>
                        </div>
                    )}
                </div>
            </div>

            {/* === 1. Session === */}
            <div style={sectionStyle}>
                <h3 style={sectionTitle}>1. Session Management</h3>
                <div style={{ display: 'flex', gap: '10px' }}>
                    <button onClick={handleLogin} style={btnStyle('#4CAF50')}>Start Manual Login</button>
                    <button onClick={() => { window.electron?.send('start-debug'); setStatus('Debug Mode...'); }} style={btnStyle('#FF5722')}>
                        🐞 Spy Mode (Debug)
                    </button>
                </div>

                {/* --- Cookie Login --- */}
                <div style={{ marginTop: '14px', padding: '12px', background: '#1a1a2e', borderRadius: '8px', border: '1px solid #333' }}>
                    <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: '#bbb', fontWeight: 'bold' }}>🍪 Login with Cookies</p>
                    <p style={{ margin: '0 0 8px 0', fontSize: '11px', color: '#666' }}>
                        Paste cookies dari browser (format: JSON array atau c_user=xxx; xs=yyy; fr=zzz). Minimal butuh cookies <strong style={{ color: '#FF9800' }}>c_user</strong> dan <strong style={{ color: '#FF9800' }}>xs</strong>.
                    </p>
                    <textarea
                        value={cookieInput}
                        onChange={e => setCookieInput(e.target.value)}
                        rows={4}
                        placeholder={'c_user=123456789; xs=abc123def456; fr=0xyz987; datr=AbCdEfG\n\natau JSON array:\n[{"name":"c_user","value":"123456789"}, ...]'}
                        style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: '11px' }}
                    />
                    <button
                        onClick={handleCookieLogin}
                        disabled={!cookieInput.trim()}
                        style={{
                            ...btnStyle(cookieInput.trim() ? '#FF9800' : '#444'),
                            marginTop: '8px',
                            cursor: cookieInput.trim() ? 'pointer' : 'not-allowed',
                            opacity: cookieInput.trim() ? 1 : 0.5,
                            width: '100%',
                        }}
                    >
                        🍪 Login with Cookies
                    </button>
                </div>
            </div>

            {/* === 2. Campaign Settings === */}
            <div style={sectionStyle}>
                <h3 style={sectionTitle}>2. Campaign Settings</h3>

                <label style={labelStyle}>Lokasi Target <span style={{ color: '#888', fontSize: '12px' }}>(pisah koma untuk multi-lokasi)</span></label>
                <textarea
                    value={city}
                    onChange={e => setCity(e.target.value)}
                    rows={2}
                    placeholder="Tulungagung, Trenggalek, Kediri"
                    style={{ ...inputStyle, resize: 'vertical' }}
                />

                <label style={labelStyle}>Radius (km)</label>
                <input type="number" value={radius} min={1} onChange={e => setRadius(Number(e.target.value))} style={inputStyle} />

                {/* ========== SEARCH KEYWORD (BIRU) ========== */}
                <label style={{ ...labelStyle, marginTop: '14px' }}>
                    🔵 Search Keyword <span style={{ color: '#f44336', fontSize: '11px' }}>* wajib</span>
                    <span style={{ color: '#888', fontSize: '12px', display: 'block' }}>Jenis barang yang dicari di Marketplace (cth: laptop, motor, iPhone)</span>
                </label>
                <input
                    type="text"
                    value={keyword}
                    onChange={e => setKeyword(e.target.value)}
                    placeholder="cth: Laptop"
                    style={{ ...inputStyle, borderColor: keyword ? '#2196F3' : '#666', borderWidth: '2px' }}
                />

                {/* ========== CAPTION KEYWORD (MERAH) ========== */}
                <label style={{ ...labelStyle, marginTop: '14px' }}>
                    🔴 Caption Keyword <span style={{ color: '#f44336', fontSize: '11px' }}>* wajib</span>
                    <span style={{ color: '#888', fontSize: '12px', display: 'block' }}>Teks yang dicari dari caption/body hasil pencarian untuk menentukan listing mana yang di-boost (cth: 081223143330, Raffa)</span>
                </label>
                <input
                    type="text"
                    value={captionKeyword}
                    onChange={e => setCaptionKeyword(e.target.value)}
                    placeholder="cth: 081223143330"
                    style={{ ...inputStyle, borderColor: captionKeyword ? '#f44336' : '#666', borderWidth: '2px' }}
                />

                {/* ========== SAVED CONTACTS ========== */}
                <div style={{ marginTop: '14px', padding: '12px', background: '#1e1e2a', borderRadius: '8px', border: '1px solid #333' }}>
                    <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: '#bbb', fontWeight: 'bold' }}>📞 Kontak Tersimpan</p>
                    <div style={{ display: 'flex', gap: '6px', marginBottom: '8px', flexWrap: 'wrap' }}>
                        <input
                            type="text"
                            value={newContactNumber}
                            onChange={e => setNewContactNumber(e.target.value)}
                            placeholder="Nomor, misal 081223143330"
                            style={{ ...inputStyle, flex: '2', minWidth: '140px' }}
                        />
                        <input
                            type="text"
                            value={newContactLabel}
                            onChange={e => setNewContactLabel(e.target.value)}
                            placeholder="Label (opsional)"
                            style={{ ...inputStyle, flex: '1', minWidth: '100px' }}
                        />
                        <button onClick={handleSaveContact} style={{ ...btnStyle('#4CAF50'), flex: 'none', padding: '8px 14px' }}>
                            💾 Simpan
                        </button>
                    </div>
                    {savedContacts.length === 0 && (
                        <p style={{ margin: 0, fontSize: '12px', color: '#555' }}>Belum ada kontak tersimpan.</p>
                    )}
                    {savedContacts.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                            {savedContacts.map(c => (
                                <div key={c.number} style={{
                                    display: 'flex', alignItems: 'center', gap: '6px',
                                    padding: '5px 10px', background: '#252535', borderRadius: '20px',
                                    border: '1px solid #444', fontSize: '12px', color: '#ccc',
                                }}>
                                    <span
                                        onClick={() => handleLoadContact(c.number)}
                                        title="Klik untuk gunakan nomor ini sebagai Caption Keyword"
                                        style={{ cursor: 'pointer', color: '#64B5F6' }}
                                    >
                                        {c.label ? `${c.label} (${c.number})` : c.number}
                                    </span>
                                    <span
                                        onClick={() => handleDeleteContact(c.number)}
                                        title="Hapus kontak"
                                        style={{ cursor: 'pointer', color: '#f44336', fontWeight: 'bold', fontSize: '14px', lineHeight: '1' }}
                                    >
                                        ×
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* ========== FACEBOOK SEARCH (OPSIONAL) ========== */}
                <label style={{ ...labelStyle, marginTop: '14px' }}>
                    🔵 Facebook Search <span style={{ color: '#888', fontSize: '12px' }}>(opsional, search FB biasa bukan Marketplace)</span>
                </label>
                <input
                    type="text"
                    value={fbKeyword}
                    onChange={e => setFbKeyword(e.target.value)}
                    placeholder="Kosongkan jika tidak perlu"
                    style={{ ...inputStyle, borderColor: fbKeyword ? '#1877F2' : '#444' }}
                />
                {showFbOrder && (
                    <div style={{ marginTop: '8px', padding: '10px', background: '#252535', borderRadius: '6px', border: '1px solid #1877F2' }}>
                        <p style={{ margin: '0 0 8px 0', fontSize: '13px', color: '#bbb' }}>Urutan pencarian:</p>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: '6px' }}>
                            <input type="radio" name="order" value="keyword_first" checked={searchOrder === 'keyword_first'} onChange={() => setSearchOrder('keyword_first')} />
                            <span>Marketplace dulu, lalu Facebook Search</span>
                        </label>
                        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                            <input type="radio" name="order" value="fb_first" checked={searchOrder === 'fb_first'} onChange={() => setSearchOrder('fb_first')} />
                            <span>🔵 Facebook Search dulu, lalu Marketplace</span>
                        </label>
                    </div>
                )}

                <label style={{ ...labelStyle, marginTop: '12px' }}>Boost Cycles (max 100)</label>
                <input
                    type="number" value={boostCount} min={1} max={100}
                    onChange={e => setBoostCount(Math.min(100, Math.max(1, Number(e.target.value) || 1)))}
                    style={inputStyle}
                />

                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginTop: '12px', fontSize: '13px', color: '#ccc' }}>
                    <input
                        type="checkbox"
                        checked={skipFailedLogin}
                        onChange={e => setSkipFailedLogin(e.target.checked)}
                        style={{ accentColor: '#FF9800' }}
                    />
                    ⏭️ Skip akun jika login gagal
                    <span style={{ color: '#888', fontSize: '11px', marginLeft: '4px' }}>
                        {skipFailedLogin ? '(akun gagal akan di-skip)' : '(bot akan menunggu intervensi manual 120 detik)'}
                    </span>
                </label>

                {!canStart && (
                    <div style={{ marginTop: '8px', padding: '8px 12px', background: '#331111', borderRadius: '4px', border: '1px solid #662222', color: '#ff8888', fontSize: '12px' }}>
                        ⚠️ Search Keyword dan Caption Keyword wajib diisi sebelum menjalankan campaign.
                    </div>
                )}

                <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
                    <button onClick={handleStart} disabled={!canStart} style={{ ...btnStyle(canStart ? '#2196F3' : '#444'), cursor: canStart ? 'pointer' : 'not-allowed', opacity: canStart ? 1 : 0.5 }}>
                        ▶️ Start Boost (Single)
                    </button>
                    <button onClick={handleScrape} style={btnStyle('#9C27B0')}>📊 Scrape to CSV</button>
                </div>
            </div>

            {/* === 3. Multi-Akun via CSV === */}
            <div style={sectionStyle}>
                <h3 style={sectionTitle}>3. Multi-Akun via CSV <span style={{ fontSize: '13px', color: '#888', fontWeight: 'normal' }}>(format: PASSWORD;email)</span></h3>

                <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' }}>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,.txt"
                        style={{ display: 'none' }}
                        onChange={handleCsvFile}
                    />
                    <button onClick={() => fileInputRef.current?.click()} style={btnStyle('#607D8B')}>
                        📂 Import CSV Akun
                    </button>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer', fontSize: '13px', color: '#ccc' }}>
                        <input
                            type="checkbox"
                            checked={gmailOnly}
                            onChange={e => setGmailOnly(e.target.checked)}
                            style={{ accentColor: '#f44336' }}
                        />
                        Hanya @gmail.com
                    </label>
                    {accounts.length > 0 && (
                        <span style={{ color: '#4CAF50', fontSize: '14px' }}>
                            ✅ {accounts.length} akun siap
                        </span>
                    )}
                    {accounts.length > 0 && (
                        <button onClick={() => setAccounts([])} style={{ ...btnStyle('#555'), padding: '6px 12px', fontSize: '12px' }}>
                            ✕ Clear
                        </button>
                    )}
                </div>

                {accounts.length > 0 && (
                    <>
                        <label style={labelStyle}>Lokasi (berlaku untuk semua akun) <span style={{ color: '#888', fontSize: '12px' }}>(pisah koma)</span></label>
                        <textarea
                            value={csvLocations}
                            onChange={e => setCsvLocations(e.target.value)}
                            rows={2}
                            placeholder="Tulungagung, Trenggalek, Kediri"
                            style={{ ...inputStyle, resize: 'vertical' }}
                        />

                        <div style={{ marginBottom: '12px' }}>
                            <label style={labelStyle}>
                                ⚡ Batas Akun Berjalan Bersamaan: <strong style={{ color: '#FFC107', fontSize: '18px' }}>{concurrentLimit}</strong>
                                <span style={{ color: '#888', fontSize: '12px', marginLeft: '8px' }}>akun</span>
                            </label>
                            <input
                                type="range"
                                min={1} max={10}
                                value={concurrentLimit}
                                onChange={e => setConcurrentLimit(Number(e.target.value))}
                                style={{ width: '100%', accentColor: '#FFC107', marginTop: '4px' }}
                            />
                            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#666' }}>
                                <span>1 (aman)</span>
                                <span>5 (sedang)</span>
                                <span>10 (berat)</span>
                            </div>
                        </div>

                        <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid #333', borderRadius: '6px', marginBottom: '12px' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                                <thead>
                                    <tr style={{ background: '#2a2a2a', position: 'sticky', top: 0 }}>
                                        <th style={thStyle}>#</th>
                                        <th style={thStyle}>Email</th>
                                        <th style={thStyle}>Password</th>
                                        <th style={thStyle}>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {accounts.map((acc, i) => (
                                        <tr key={acc.email} style={{ background: i % 2 === 0 ? '#1e1e1e' : '#222' }}>
                                            <td style={tdStyle}>{i + 1}</td>
                                            <td style={tdStyle}>{acc.email}</td>
                                            <td style={{ ...tdStyle, color: '#666' }}>{'•'.repeat(Math.min(acc.password.length, 10))}</td>
                                            <td style={{ ...tdStyle, color: statusColor(acc.status), fontWeight: 'bold' }}>
                                                {acc.status === 'running' ? '⏳ Running...' :
                                                    acc.status === 'done' ? '✅ Done' :
                                                        acc.status === 'error' ? `❌ ${acc.statusText || 'Error'}` :
                                                            '⏸ Pending'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <button
                            onClick={handleRunCampaign}
                            disabled={campaignRunning || !canStart}
                            style={{
                                ...btnStyle(campaignRunning || !canStart ? '#444' : '#E65100'),
                                width: '100%',
                                fontSize: '15px',
                                padding: '12px',
                                cursor: campaignRunning || !canStart ? 'not-allowed' : 'pointer',
                                opacity: campaignRunning || !canStart ? 0.7 : 1,
                            }}
                        >
                            {campaignRunning
                                ? `⏳ Campaign berjalan... (${accounts.filter(a => a.status === 'done').length}/${accounts.length} selesai)`
                                : !canStart
                                    ? '⚠️ Isi Search Keyword & Caption Keyword dulu'
                                    : `🚀 Jalankan ${accounts.length} Akun (${concurrentLimit} bersamaan)`
                            }
                        </button>
                    </>
                )}
            </div>

            {/* === 4. Multi-Akun via Cookies === */}
            <div style={sectionStyle}>
                <h3 style={sectionTitle}>4. Multi-Akun via Cookies <span style={{ fontSize: '13px', color: '#888', fontWeight: 'normal' }}>(1 baris = 1 akun)</span></h3>

                <label style={labelStyle}>
                    Paste cookies (1 baris per akun). Minimal butuh <strong style={{ color: '#FF9800' }}>c_user</strong> dan <strong style={{ color: '#FF9800' }}>xs</strong> per baris.
                </label>
                <textarea
                    value={cookieCampaignInput}
                    onChange={e => setCookieCampaignInput(e.target.value)}
                    rows={5}
                    placeholder={'c_user=111111; xs=aaa111; fr=bbb111; datr=ccc111\nc_user=222222; xs=aaa222; fr=bbb222; datr=ccc222\nc_user=333333; xs=aaa333; fr=bbb333; datr=ccc333'}
                    style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: '11px' }}
                />

                <div style={{ display: 'flex', gap: '10px', marginTop: '8px', alignItems: 'center' }}>
                    <button
                        onClick={handleParseCookies}
                        disabled={!cookieCampaignInput.trim()}
                        style={{ ...btnStyle(cookieCampaignInput.trim() ? '#607D8B' : '#444'), cursor: cookieCampaignInput.trim() ? 'pointer' : 'not-allowed', opacity: cookieCampaignInput.trim() ? 1 : 0.5 }}
                    >
                        🔍 Parse Cookies
                    </button>
                    {cookieAccounts.length > 0 && (
                        <span style={{ color: '#4CAF50', fontSize: '14px' }}>
                            ✅ {cookieAccounts.length} akun siap
                        </span>
                    )}
                    {cookieAccounts.length > 0 && (
                        <button onClick={() => setCookieAccounts([])} style={{ ...btnStyle('#555'), padding: '6px 12px', fontSize: '12px' }}>
                            ✕ Clear
                        </button>
                    )}
                </div>

                {cookieAccounts.length > 0 && (
                    <>
                        <div style={{ maxHeight: '220px', overflowY: 'auto', border: '1px solid #333', borderRadius: '6px', marginTop: '12px', marginBottom: '12px' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                                <thead>
                                    <tr style={{ background: '#2a2a2a', position: 'sticky', top: 0 }}>
                                        <th style={thStyle}>#</th>
                                        <th style={thStyle}>c_user (ID)</th>
                                        <th style={thStyle}>Cookies</th>
                                        <th style={thStyle}>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {cookieAccounts.map((acc, i) => (
                                        <tr key={acc.id + '_' + i} style={{ background: i % 2 === 0 ? '#1e1e1e' : '#222' }}>
                                            <td style={tdStyle}>{i + 1}</td>
                                            <td style={{ ...tdStyle, color: '#FF9800', fontFamily: 'monospace' }}>{acc.id}</td>
                                            <td style={{ ...tdStyle, color: '#666', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {acc.cookieStr.substring(0, 40)}...
                                            </td>
                                            <td style={{ ...tdStyle, color: statusColor(acc.status), fontWeight: 'bold' }}>
                                                {acc.status === 'running' ? '⏳ Running...' :
                                                    acc.status === 'done' ? '✅ Done' :
                                                        acc.status === 'error' ? `❌ ${acc.statusText || 'Error'}` :
                                                            '⏸ Pending'}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        <button
                            onClick={handleRunCookieCampaign}
                            disabled={cookieCampaignRunning || !canStart}
                            style={{
                                ...btnStyle(cookieCampaignRunning || !canStart ? '#444' : '#FF9800'),
                                width: '100%',
                                fontSize: '15px',
                                padding: '12px',
                                cursor: cookieCampaignRunning || !canStart ? 'not-allowed' : 'pointer',
                                opacity: cookieCampaignRunning || !canStart ? 0.7 : 1,
                            }}
                        >
                            {cookieCampaignRunning
                                ? `⏳ Cookie Campaign berjalan... (${cookieAccounts.filter(a => a.status === 'done').length}/${cookieAccounts.length} selesai)`
                                : !canStart
                                    ? '⚠️ Isi Search Keyword & Caption Keyword dulu'
                                    : `🍪 Jalankan ${cookieAccounts.length} Akun Cookie (${concurrentLimit} bersamaan)`
                            }
                        </button>
                    </>
                )}
            </div>

            {/* === 5. Log Output === */}
            <div style={{ padding: '15px', border: '1px solid #333', borderRadius: '8px', background: '#0a0a0a' }}>
                <h3 style={{ margin: '0 0 8px 0' }}>
                    Status: <span style={{ color: '#FFC107' }}>{status}</span>
                </h3>
                <div style={{ height: '220px', overflowY: 'auto', fontFamily: 'monospace', fontSize: '11px', color: '#aaa', lineHeight: '1.5' }}>
                    {logs.length === 0 && <div style={{ color: '#555' }}>Belum ada log...</div>}
                    {logs.map((log, i) => <div key={i}>{log}</div>)}
                </div>
            </div>
        </div>
    );
};

// --- Styles ---
const sectionStyle: React.CSSProperties = {
    marginBottom: '20px', padding: '16px',
    border: '1px solid #333', borderRadius: '8px', background: '#141414',
};
const sectionTitle: React.CSSProperties = {
    margin: '0 0 14px 0', fontSize: '15px', color: '#ddd',
};
const labelStyle: React.CSSProperties = {
    display: 'block', marginBottom: '4px', marginTop: '10px', fontSize: '13px', color: '#bbb',
};
const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', background: '#222',
    border: '1px solid #444', borderRadius: '4px', color: '#eee',
    fontSize: '13px', boxSizing: 'border-box',
};
const btnStyle = (bg: string): React.CSSProperties => ({
    flex: 1, padding: '10px 16px', cursor: 'pointer',
    background: bg, color: 'white', border: 'none', borderRadius: '4px',
    fontSize: '13px', fontWeight: 'bold',
});
const thStyle: React.CSSProperties = {
    padding: '7px 10px', textAlign: 'left', color: '#999', fontWeight: 'bold', borderBottom: '1px solid #333',
};
const tdStyle: React.CSSProperties = {
    padding: '6px 10px', borderBottom: '1px solid #2a2a2a', color: '#ccc',
};

export default App;
