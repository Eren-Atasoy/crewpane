// CrewPane — Jev AI Orchestrator Frontend Integration & UI Bridge
//
// Injects rich Jev Orchestrator controls into the CrewPane UI:
//   1. Settings / AI Engines / Jev AI settings panel (Mode, Policy, Budget Cap)
//   2. Floating Quick-Access Jev Widget (Status indicator & quick popup)
//   3. Live Task Routing Simulator & Decision Log inspector
'use strict';

(function initJevUiBridge() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  // State cache
  let currentSettings = {
    mode: 'suggest',
    policy: 'balanced',
    maxCostPerTaskUsd: null,
  };

  let isInitialized = false;

  async function loadJevSettings() {
    try {
      if (window.settingsApi && typeof window.settingsApi.get === 'function') {
        const res = await window.settingsApi.get();
        if (res && res.jev) {
          currentSettings = {
            mode: res.jev.mode || 'suggest',
            policy: res.jev.policy || 'balanced',
            maxCostPerTaskUsd: res.jev.maxCostPerTaskUsd ?? null,
          };
          updateAllUiElements();
        }
      }
    } catch (_e) {
      /* best-effort */
    }
  }

  async function saveJevSettings(patch) {
    try {
      currentSettings = { ...currentSettings, ...patch };
      if (window.settingsApi && typeof window.settingsApi.set === 'function') {
        await window.settingsApi.set({ jev: currentSettings });
      }
      updateAllUiElements();
      showToast('Jev AI ayarları güncellendi');
    } catch (e) {
      showToast('Ayar kaydedilemedi: ' + e.message, true);
    }
  }

  function showToast(msg, isError = false) {
    const existing = document.getElementById('jev-ui-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'jev-ui-toast';
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 999999;
      background: ${isError ? 'rgba(239, 68, 68, 0.95)' : 'rgba(16, 185, 129, 0.95)'};
      color: #fff;
      padding: 10px 18px;
      border-radius: 8px;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      gap: 8px;
      animation: jevFadeIn 0.25s ease-out;
      pointer-events: none;
    `;
    toast.innerHTML = `<span>${isError ? '⚠️' : '✓'}</span> <span>${escapeHtml(msg)}</span>`;
    document.body.appendChild(toast);
    setTimeout(() => {
      if (toast && toast.parentNode) toast.remove();
    }, 3000);
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function updateAllUiElements() {
    // 1. Update floating pill badge
    const badgeText = document.getElementById('jev-floating-pill-text');
    if (badgeText) {
      const modeLabel = currentSettings.mode === 'auto' ? 'Otomatik' : currentSettings.mode === 'suggest' ? 'Öneri' : 'Kapalı';
      const policyLabel = currentSettings.policy === 'frugal' ? 'Tasarruf' : currentSettings.policy === 'quality' ? 'Kalite' : 'Dengeli';
      badgeText.textContent = `Jev AI: ${modeLabel} (${policyLabel})`;
    }

    // 2. Update embedded settings controls if present
    document.querySelectorAll('.jev-mode-btn').forEach((btn) => {
      const mode = btn.getAttribute('data-mode');
      if (mode === currentSettings.mode) {
        btn.classList.add('jev-active-pill');
      } else {
        btn.classList.remove('jev-active-pill');
      }
    });

    document.querySelectorAll('.jev-policy-btn').forEach((btn) => {
      const policy = btn.getAttribute('data-policy');
      if (policy === currentSettings.policy) {
        btn.classList.add('jev-active-pill');
      } else {
        btn.classList.remove('jev-active-pill');
      }
    });

    const budgetInput = document.getElementById('jev-budget-cap-input');
    if (budgetInput && document.activeElement !== budgetInput) {
      budgetInput.value = currentSettings.maxCostPerTaskUsd !== null ? currentSettings.maxCostPerTaskUsd : '';
    }
  }

  function injectStyles() {
    if (document.getElementById('jev-ui-styles')) return;
    const style = document.createElement('style');
    style.id = 'jev-ui-styles';
    style.textContent = `
      @keyframes jevFadeIn {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .jev-pill-group {
        display: flex;
        gap: 6px;
        margin-top: 6px;
        flex-wrap: wrap;
      }
      .jev-pill-btn {
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #94a3b8;
        padding: 6px 14px;
        border-radius: 6px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.18s ease;
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .jev-pill-btn:hover {
        background: rgba(255, 255, 255, 0.1);
        color: #f1f5f9;
        border-color: rgba(255, 255, 255, 0.25);
      }
      .jev-pill-btn.jev-active-pill {
        background: rgba(59, 130, 246, 0.2);
        border-color: #3b82f6;
        color: #60a5fa;
        box-shadow: 0 0 12px rgba(59, 130, 246, 0.25);
      }
      .jev-section-card {
        background: rgba(18, 22, 34, 0.7);
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        padding: 16px;
        margin: 14px 0;
        backdrop-filter: blur(8px);
      }
      .jev-section-title {
        font-size: 13px;
        font-weight: 600;
        color: #e2e8f0;
        margin-bottom: 4px;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .jev-section-desc {
        font-size: 12px;
        color: #64748b;
        margin-bottom: 8px;
        line-height: 1.4;
      }
      .jev-input {
        background: rgba(0, 0, 0, 0.35);
        border: 1px solid rgba(255, 255, 255, 0.12);
        color: #f8fafc;
        border-radius: 6px;
        padding: 8px 12px;
        font-size: 12px;
        outline: none;
        transition: border 0.18s ease;
        width: 100%;
        box-sizing: border-box;
      }
      .jev-input:focus {
        border-color: #3b82f6;
      }
      .jev-btn-primary {
        background: #2563eb;
        color: #fff;
        border: none;
        border-radius: 6px;
        padding: 7px 14px;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.18s ease;
      }
      .jev-btn-primary:hover {
        background: #1d4ed8;
      }
      .jev-badge {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 600;
      }
      .jev-badge-routine { background: rgba(16, 185, 129, 0.18); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.3); }
      .jev-badge-standard { background: rgba(59, 130, 246, 0.18); color: #60a5fa; border: 1px solid rgba(59, 130, 246, 0.3); }
      .jev-badge-expert { background: rgba(168, 85, 247, 0.18); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); }
    `;
    document.head.appendChild(style);
  }

  // Inject or update Jev controls directly inside the Settings / AI Engines / Jev AI view
  function injectSettingsControls() {
    // Check if the current view contains Jev AI card
    const jevHeaders = Array.from(document.querySelectorAll('h1, h2, h3, h4, div, span')).filter((el) => {
      return el.textContent && el.textContent.trim() === 'Jev AI' && !el.closest('#jev-embedded-controls') && !el.closest('#jev-floating-panel');
    });

    if (!jevHeaders.length) return;

    // Find the engine card container
    const jevHeader = jevHeaders[0];
    const cardContainer = jevHeader.closest('.space-y-4') || jevHeader.closest('.rounded-lg') || jevHeader.parentElement?.parentElement;
    if (!cardContainer || cardContainer.querySelector('#jev-embedded-controls')) return;

    const panel = document.createElement('div');
    panel.id = 'jev-embedded-controls';
    panel.className = 'jev-section-card';
    panel.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; border-bottom:1px solid rgba(255,255,255,0.08); padding-bottom:8px;">
        <div class="jev-section-title" style="margin:0; font-size:14px;">
          <span>⚡</span> Jev AI Akıllı Model Yönlendirici (Orchestrator) Ayarları
        </div>
        <span class="jev-badge jev-badge-standard">Faz 0-6 Çekirdek Aktif</span>
      </div>

      <!-- 1. ÇALIŞMA MODU -->
      <div style="margin-bottom: 14px;">
        <div class="jev-section-title">Çalışma Modu</div>
        <div class="jev-section-desc">Jev'in görevleri nasıl işleyeceğini seçin.</div>
        <div class="jev-pill-group">
          <button id="jev-mode-suggest-btn" class="jev-pill-btn jev-mode-btn ${currentSettings.mode === 'suggest' ? 'jev-active-pill' : ''}" data-mode="suggest">
            💡 Öneri Modu (Suggest) <span style="font-size:10px; opacity:0.7;">(Varsayılan)</span>
          </button>
          <button id="jev-mode-auto-btn" class="jev-pill-btn jev-mode-btn ${currentSettings.mode === 'auto' ? 'jev-active-pill' : ''}" data-mode="auto">
            ⚡ Tam Otomatik (Auto)
          </button>
          <button id="jev-mode-off-btn" class="jev-pill-btn jev-mode-btn ${currentSettings.mode === 'off' ? 'jev-active-pill' : ''}" data-mode="off">
            ⏸️ Kapalı (Off)
          </button>
        </div>
      </div>

      <!-- 2. MODEL SEÇİM POLİTİKASI -->
      <div style="margin-bottom: 14px;">
        <div class="jev-section-title">Karar & Maliyet Politikası</div>
        <div class="jev-section-desc">Jev bağlı motorlar arasından seçim yaparken hangi önceliği gözetsin?</div>
        <div class="jev-pill-group">
          <button id="jev-policy-frugal-btn" class="jev-pill-btn jev-policy-btn ${currentSettings.policy === 'frugal' ? 'jev-active-pill' : ''}" data-policy="frugal">
            🟢 Tasarruf (Frugal)
          </button>
          <button id="jev-policy-balanced-btn" class="jev-pill-btn jev-policy-btn ${currentSettings.policy === 'balanced' ? 'jev-active-pill' : ''}" data-policy="balanced">
            🟡 Dengeli (Balanced)
          </button>
          <button id="jev-policy-quality-btn" class="jev-pill-btn jev-policy-btn ${currentSettings.policy === 'quality' ? 'jev-active-pill' : ''}" data-policy="quality">
            🟣 Maksimum Kalite (Quality)
          </button>
        </div>
      </div>

      <!-- 3. BÜTÇE TAVANI -->
      <div style="margin-bottom: 14px;">
        <div class="jev-section-title">Görev Başına Bütçe Tavanı (USD)</div>
        <div class="jev-section-desc">Eskalasyon veya görev çalıştırmasında bu tavan aşılırsa işlem durdurulur ve onay istenir.</div>
        <div style="display:flex; gap:8px; align-items:center; max-width:240px;">
          <input id="jev-budget-cap-input" type="number" step="0.01" min="0" placeholder="Sınırsız" class="jev-input" value="${currentSettings.maxCostPerTaskUsd ?? ''}" />
          <button id="jev-budget-save-btn" class="jev-btn-primary">Kaydet</button>
        </div>
      </div>

      <!-- 4. CANLI TEST VE YÖNLENDİRME SİMÜLATÖRÜ -->
      <div style="margin-top: 16px; padding-top: 14px; border-top: 1px solid rgba(255,255,255,0.08);">
        <div class="jev-section-title">🧪 Canlı Model Yönlendirme Testi</div>
        <div class="jev-section-desc">Bir görev başlığı yazarak Jev'in hangi modeli ve nedeni seçeceğini anında test edin.</div>
        <div style="display:flex; gap:8px; margin-bottom:8px;">
          <input id="jev-test-task-input" type="text" placeholder="Örnek: CSS buton rengini güncelle veya Kritik veritabanı migration" class="jev-input" />
          <button id="jev-test-route-btn" class="jev-btn-primary" style="white-space:nowrap;">Jev ile Analiz Et</button>
        </div>
        <div id="jev-test-result-box" style="display:none; padding:10px; background:rgba(0,0,0,0.3); border-radius:6px; font-size:12px; margin-top:8px;"></div>
      </div>
    `;

    // Insert panel right after description or near top of the card
    cardContainer.insertBefore(panel, cardContainer.children[1] || cardContainer.firstChild);

    // Bind event handlers
    panel.querySelectorAll('.jev-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-mode');
        saveJevSettings({ mode });
      });
    });

    panel.querySelectorAll('.jev-policy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const policy = btn.getAttribute('data-policy');
        saveJevSettings({ policy });
      });
    });

    const budgetBtn = panel.querySelector('#jev-budget-save-btn');
    const budgetInput = panel.querySelector('#jev-budget-cap-input');
    if (budgetBtn && budgetInput) {
      budgetBtn.addEventListener('click', () => {
        const val = budgetInput.value.trim();
        const num = val ? parseFloat(val) : null;
        saveJevSettings({ maxCostPerTaskUsd: Number.isFinite(num) ? num : null });
      });
    }

    const testBtn = panel.querySelector('#jev-test-route-btn');
    const testInput = panel.querySelector('#jev-test-task-input');
    const resultBox = panel.querySelector('#jev-test-result-box');
    if (testBtn && testInput && resultBox) {
      testBtn.addEventListener('click', async () => {
        const title = testInput.value.trim();
        if (!title) {
          resultBox.style.display = 'block';
          resultBox.innerHTML = '<span style="color:#ef4444;">Lütfen test etmek için bir görev başlığı yazın.</span>';
          return;
        }
        testBtn.disabled = true;
        testBtn.textContent = 'Analiz ediliyor...';
        try {
          const res = await window.engineApi.routeTask({
            task: { title },
            policy: currentSettings.policy,
            force: true,
          });
          const dec = res && res.decision;
          if (dec) {
            const badgeClass = dec.tier === 'expert' ? 'jev-badge-expert' : dec.tier === 'routine' ? 'jev-badge-routine' : 'jev-badge-standard';
            resultBox.style.display = 'block';
            resultBox.innerHTML = `
              <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <strong>Seçilen Model: <span style="color:#60a5fa;">${escapeHtml(dec.model || 'Otomatik')}</span></strong>
                <span class="jev-badge ${badgeClass}">${escapeHtml(dec.tier).toUpperCase()}</span>
              </div>
              <div style="color:#94a3b8; font-size:11px; margin-bottom:4px;">
                Motor: <strong>${escapeHtml(dec.engine || 'claude')}</strong> · Efor: <strong>${escapeHtml(dec.effort || 'orta')}</strong>
              </div>
              <div style="color:#cbd5e1; font-size:11px;">
                Karar Kodu: <code>${escapeHtml(dec.reason?.code || 'standart')}</code>
              </div>
            `;
          } else {
            resultBox.style.display = 'block';
            resultBox.innerHTML = '<span style="color:#f59e0b;">Karar üretilemedi (bağlı motor bulunamadı veya görev atlandı).</span>';
          }
        } catch (err) {
          resultBox.style.display = 'block';
          resultBox.innerHTML = `<span style="color:#ef4444;">Hata: ${escapeHtml(err.message)}</span>`;
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = 'Jev ile Analiz Et';
        }
      });
    }
  }

  // Floating Quick-Access Indicator & Control Modal
  function injectFloatingWidget() {
    if (document.getElementById('jev-floating-widget')) return;

    const widget = document.createElement('div');
    widget.id = 'jev-floating-widget';
    widget.style.cssText = `
      position: fixed;
      bottom: 12px;
      right: 18px;
      z-index: 99999;
      display: flex;
      align-items: center;
    `;

    const pill = document.createElement('button');
    pill.id = 'jev-floating-pill';
    pill.className = 'jev-pill-btn';
    pill.style.cssText = `
      background: rgba(15, 23, 42, 0.88);
      border: 1px solid rgba(59, 130, 246, 0.4);
      color: #93c5fd;
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 11px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
      cursor: pointer;
      backdrop-filter: blur(8px);
      display: flex;
      align-items: center;
      gap: 6px;
    `;
    pill.innerHTML = `
      <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#10b981; box-shadow:0 0 8px #10b981;"></span>
      <span id="jev-floating-pill-text">Jev AI: Öneri (Dengeli)</span>
    `;

    pill.addEventListener('click', toggleQuickModal);
    widget.appendChild(pill);
    document.body.appendChild(widget);
  }

  function toggleQuickModal() {
    let modal = document.getElementById('jev-quick-modal');
    if (modal) {
      modal.remove();
      return;
    }

    modal = document.createElement('div');
    modal.id = 'jev-quick-modal';
    modal.style.cssText = `
      position: fixed;
      bottom: 50px;
      right: 18px;
      width: 360px;
      background: #0f172a;
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 12px;
      box-shadow: 0 16px 40px rgba(0, 0, 0, 0.6);
      padding: 16px;
      z-index: 100000;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      animation: jevFadeIn 0.2s ease-out;
      backdrop-filter: blur(12px);
    `;

    modal.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <strong style="color:#f8fafc; font-size:13px; display:flex; align-items:center; gap:6px;">
          <span>⚡</span> Jev AI Hızlı Kontrol Paneli
        </strong>
        <button id="jev-quick-modal-close" style="background:transparent; border:none; color:#64748b; font-size:16px; cursor:pointer;">✕</button>
      </div>

      <!-- Quick Mode Selector -->
      <div style="margin-bottom:12px;">
        <div style="font-size:11px; color:#94a3b8; margin-bottom:4px; font-weight:600;">Çalışma Modu:</div>
        <div class="jev-pill-group">
          <button class="jev-pill-btn jev-mode-btn ${currentSettings.mode === 'suggest' ? 'jev-active-pill' : ''}" data-mode="suggest">Öneri</button>
          <button class="jev-pill-btn jev-mode-btn ${currentSettings.mode === 'auto' ? 'jev-active-pill' : ''}" data-mode="auto">Otomatik</button>
          <button class="jev-pill-btn jev-mode-btn ${currentSettings.mode === 'off' ? 'jev-active-pill' : ''}" data-mode="off">Kapalı</button>
        </div>
      </div>

      <!-- Quick Policy Selector -->
      <div style="margin-bottom:12px;">
        <div style="font-size:11px; color:#94a3b8; margin-bottom:4px; font-weight:600;">Politika:</div>
        <div class="jev-pill-group">
          <button class="jev-pill-btn jev-policy-btn ${currentSettings.policy === 'frugal' ? 'jev-active-pill' : ''}" data-policy="frugal">Tasarruf</button>
          <button class="jev-pill-btn jev-policy-btn ${currentSettings.policy === 'balanced' ? 'jev-active-pill' : ''}" data-policy="balanced">Dengeli</button>
          <button class="jev-pill-btn jev-policy-btn ${currentSettings.policy === 'quality' ? 'jev-active-pill' : ''}" data-policy="quality">Kalite</button>
        </div>
      </div>

      <!-- Quick Actions -->
      <div style="margin-top:14px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.08); display:flex; gap:8px;">
        <button id="jev-quick-logs-btn" class="jev-btn-primary" style="flex:1; font-size:11px;">Son Kararları Gör</button>
        <button id="jev-quick-test-btn" class="jev-pill-btn" style="flex:1; justify-content:center; font-size:11px;">Test Et</button>
      </div>

      <div id="jev-quick-log-output" style="display:none; max-height:160px; overflow-y:auto; margin-top:10px; background:rgba(0,0,0,0.4); border-radius:6px; padding:8px; font-size:11px; color:#cbd5e1;"></div>
    `;

    document.body.appendChild(modal);

    modal.querySelector('#jev-quick-modal-close').addEventListener('click', () => modal.remove());

    modal.querySelectorAll('.jev-mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveJevSettings({ mode: btn.getAttribute('data-mode') });
      });
    });

    modal.querySelectorAll('.jev-policy-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        saveJevSettings({ policy: btn.getAttribute('data-policy') });
      });
    });

    const logsBtn = modal.querySelector('#jev-quick-logs-btn');
    const logBox = modal.querySelector('#jev-quick-log-output');
    if (logsBtn && logBox) {
      logsBtn.addEventListener('click', async () => {
        logBox.style.display = 'block';
        logBox.textContent = 'Yükleniyor...';
        try {
          const res = await window.engineApi.decisionLog({ limit: 5 });
          const logs = (res && res.logs) || [];
          if (!logs.length) {
            logBox.innerHTML = '<span style="color:#64748b;">Henüz kaydedilmiş bir Jev kararı yok.</span>';
            return;
          }
          logBox.innerHTML = logs
            .map(
              (l) => `
            <div style="border-bottom:1px solid rgba(255,255,255,0.06); padding:4px 0; margin-bottom:4px;">
              <span style="color:#60a5fa; font-weight:600;">${escapeHtml(l.decision?.model || 'Otomatik')}</span>
              <span style="color:#94a3b8;">(${escapeHtml(l.decision?.tier || 'standard')})</span>
              <div style="color:#cbd5e1; font-size:10px;">${escapeHtml(l.task?.title || 'Görev')}</div>
            </div>
          `,
            )
            .join('');
        } catch (e) {
          logBox.innerHTML = `<span style="color:#ef4444;">${escapeHtml(e.message)}</span>`;
        }
      });
    }

    const quickTestBtn = modal.querySelector('#jev-quick-test-btn');
    if (quickTestBtn) {
      quickTestBtn.addEventListener('click', () => {
        modal.remove();
        // Trigger Settings modal if open or show alert
        const jevCard = document.getElementById('jev-embedded-controls');
        if (jevCard) {
          jevCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
          const input = jevCard.querySelector('#jev-test-task-input');
          if (input) input.focus();
        } else {
          showToast('Ayarlar > AI Motorları > Jev AI sekmesinde tam test aracını kullanabilirsiniz.');
        }
      });
    }
  }

  function setupObserver() {
    const observer = new MutationObserver(() => {
      injectSettingsControls();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  function boot() {
    if (isInitialized) return;
    isInitialized = true;
    injectStyles();
    loadJevSettings();
    injectFloatingWidget();
    injectSettingsControls();
    setupObserver();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
