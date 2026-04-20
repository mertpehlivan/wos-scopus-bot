// diagnostics.js — Diagnostic dashboard for WoS Bot scraping
document.addEventListener('DOMContentLoaded', () => {
    // ── State ──
    let diagData = { tasks: [], plumxResults: [] };
    let selectedTaskId = null;
    let filterCitations = 'all';
    let filterDetail = 'all';

    // ── DOM Refs ──
    const statTotalTasks = document.getElementById('stat-total-tasks');
    const statTotalArticles = document.getElementById('stat-total-articles');
    const statWithCitations = document.getElementById('stat-with-citations');
    const statZeroCitations = document.getElementById('stat-zero-citations');
    const statWithDoi = document.getElementById('stat-with-doi');
    const statDetailFails = document.getElementById('stat-detail-fails');
    const statPlumxCount = document.getElementById('stat-plumx-count');
    const taskList = document.getElementById('task-list');
    const taskCountBadge = document.getElementById('task-count-badge');
    const taskDetailSection = document.getElementById('task-detail-section');
    const articlesTbody = document.getElementById('articles-tbody');
    const articleCountBadge = document.getElementById('article-count-badge');
    const plumxTbody = document.getElementById('plumx-tbody');
    const plumxCountBadge = document.getElementById('plumx-count-badge');
    const filterCitationsEl = document.getElementById('filter-citations');
    const filterDetailEl = document.getElementById('filter-detail');

    // ── Load Data ──
    function loadData() {
        chrome.runtime.sendMessage({ type: 'GET_DIAG_DATA' }, (response) => {
            if (chrome.runtime.lastError) {
                console.warn('Failed to get diag data:', chrome.runtime.lastError);
                return;
            }
            if (response) {
                diagData = response;
                render();
            }
        });
    }

    // ── Summary Stats ──
    function computeStats() {
        let totalArticles = 0, withCitations = 0, zeroCitations = 0, withDoi = 0, detailFails = 0;

        diagData.tasks.forEach(task => {
            if (!task.articles) return;
            totalArticles += task.articles.length;
            task.articles.forEach(a => {
                const totalCit = (a.citations || 0) + (a.citationCountScholar || 0);
                if (totalCit > 0) withCitations++;
                else zeroCitations++;

                if (a.detailData && a.detailData.doi) withDoi++;
                if (a.detailStatus === 'FAILED') detailFails++;
            });
        });

        return { totalArticles, withCitations, zeroCitations, withDoi, detailFails };
    }

    function renderStats() {
        const s = computeStats();
        statTotalTasks.textContent = diagData.tasks.length;
        statTotalArticles.textContent = s.totalArticles;
        statWithCitations.textContent = s.withCitations;
        statZeroCitations.textContent = s.zeroCitations;
        statWithDoi.textContent = s.withDoi;
        statDetailFails.textContent = s.detailFails;
        statPlumxCount.textContent = diagData.plumxResults.length;
    }

    // ── Task List ──
    function renderTaskList() {
        const tasks = diagData.tasks;
        taskCountBadge.textContent = tasks.length;

        if (tasks.length === 0) {
            taskList.innerHTML = '<div class="empty-state">No tasks recorded yet. Trigger a sync from the Research Dashboard.</div>';
            return;
        }

        taskList.innerHTML = tasks.map(task => {
            const articleCount = task.articles ? task.articles.length : 0;
            const time = task.startedAt ? formatTime(task.startedAt) : '—';
            const isActive = selectedTaskId === task.taskId;

            return `
                <div class="task-item ${isActive ? 'active' : ''}" data-task-id="${task.taskId}">
                    <span class="task-id">#${task.taskId}</span>
                    <span class="task-source ${task.source}">${task.source}</span>
                    <span class="task-external-id" title="${task.externalId || ''}">${task.externalId || '—'}</span>
                    <span class="task-articles-count">${articleCount} articles</span>
                    <span class="task-time">${time}</span>
                    <span class="task-status-badge ${task.status}">${task.status}</span>
                </div>
            `;
        }).join('');

        // Click handlers
        taskList.querySelectorAll('.task-item').forEach(el => {
            el.addEventListener('click', () => {
                selectedTaskId = parseInt(el.dataset.taskId, 10) || el.dataset.taskId;
                render();
            });
        });
    }

    // ── Task Detail (Articles Table) ──
    function renderTaskDetail() {
        const task = diagData.tasks.find(t => t.taskId === selectedTaskId);
        if (!task) {
            taskDetailSection.style.display = 'none';
            return;
        }

        taskDetailSection.style.display = '';

        // Render metrics row if available
        let metricsHtml = '';
        if (task.metrics) {
            const m = task.metrics;
            metricsHtml = `
                <div class="metrics-row">
                    <div class="metrics-item"><span class="value">${m.hIndex || 0}</span><span class="label">H-Index</span></div>
                    <div class="metrics-item"><span class="value">${m.sumOfTimesCited || 0}</span><span class="label">Citations</span></div>
                    <div class="metrics-item"><span class="value">${m.publications || 0}</span><span class="label">Documents</span></div>
                    ${m.i10Index ? `<div class="metrics-item"><span class="value">${m.i10Index}</span><span class="label">i10-index</span></div>` : ''}
                    ${m.citingArticles ? `<div class="metrics-item"><span class="value">${m.citingArticles}</span><span class="label">Citing Articles</span></div>` : ''}
                </div>
            `;
        }

        // Insert metrics before table
        const existingMetrics = taskDetailSection.querySelector('.metrics-row');
        if (existingMetrics) existingMetrics.remove();
        if (metricsHtml) {
            const wrapper = taskDetailSection.querySelector('.table-wrapper');
            wrapper.insertAdjacentHTML('beforebegin', metricsHtml);
        }

        // Filter articles
        let articles = task.articles || [];
        if (filterCitations === 'has') {
            articles = articles.filter(a => (a.citations || 0) + (a.citationCountScholar || 0) > 0);
        } else if (filterCitations === 'zero') {
            articles = articles.filter(a => (a.citations || 0) + (a.citationCountScholar || 0) === 0);
        }
        if (filterDetail !== 'all') {
            articles = articles.filter(a => a.detailStatus === filterDetail);
        }

        articleCountBadge.textContent = `${articles.length} / ${(task.articles || []).length}`;

        if (articles.length === 0) {
            articlesTbody.innerHTML = '<tr><td colspan="7" class="empty-state">No articles match the current filters.</td></tr>';
            return;
        }

        articlesTbody.innerHTML = articles.map((a, i) => {
            const wosCit = a.citations || 0;
            const scholarCit = a.citationCountScholar || 0;
            const doi = a.detailData?.doi || '';
            const indexTypes = a.detailData?.indexTypes || [];

            return `
                <tr>
                    <td class="col-num">${i + 1}</td>
                    <td><span class="title-cell" title="${escHtml(a.title)}">${escHtml(a.title)}</span></td>
                    <td><span class="citation-cell ${wosCit > 0 ? 'positive' : 'zero'}">${wosCit || '—'}</span></td>
                    <td><span class="citation-cell ${scholarCit > 0 ? 'positive' : 'zero'}">${scholarCit || '—'}</span></td>
                    <td><span class="doi-cell">${doi ? `<a href="https://doi.org/${doi}" target="_blank" title="${doi}">${doi}</a>` : '<span style="color:var(--text-muted)">—</span>'}</span></td>
                    <td>${indexTypes.length > 0 ? indexTypes.map(t => `<span class="index-badge ${getIndexClass(t)}">${t}</span>`).join(' ') : '<span style="color:var(--text-muted)">—</span>'}</td>
                    <td><span class="detail-badge ${a.detailStatus}">${a.detailStatus}</span></td>
                </tr>
            `;
        }).join('');
    }

    // ── PlumX Table ──
    function renderPlumx() {
        const results = diagData.plumxResults || [];
        plumxCountBadge.textContent = results.length;

        if (results.length === 0) {
            plumxTbody.innerHTML = '<tr><td colspan="6" class="empty-state">No PlumX results yet.</td></tr>';
            return;
        }

        plumxTbody.innerHTML = results.map((r, i) => `
            <tr>
                <td class="col-num">${i + 1}</td>
                <td><span class="plumx-doi" title="${r.doi}">${r.doi}</span></td>
                <td><span class="citation-cell ${r.scopusCitations > 0 ? 'positive' : 'zero'}">${r.scopusCitations}</span></td>
                <td><span class="citation-cell ${r.mendeleyCitations > 0 ? 'positive' : 'zero'}">${r.mendeleyCitations}</span></td>
                <td><span class="citation-cell ${r.crossrefCitations > 0 ? 'positive' : 'zero'}">${r.crossrefCitations}</span></td>
                <td style="font-size:11px;color:var(--text-muted)">${formatTime(r.timestamp)}</td>
            </tr>
        `).join('');
    }

    // ── Main render ──
    function render() {
        renderStats();
        renderTaskList();
        renderTaskDetail();
        renderPlumx();
    }

    // ── Helpers ──
    function formatTime(isoStr) {
        if (!isoStr) return '—';
        const d = new Date(isoStr);
        return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    function escHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function getIndexClass(indexType) {
        const t = (indexType || '').toUpperCase();
        if (t.includes('SCI-E') || t.includes('SCIE') || t === 'SCI') return 'sci';
        if (t.includes('SSCI')) return 'ssci';
        if (t.includes('AHCI')) return 'ahci';
        if (t.includes('ESCI')) return 'esci';
        return 'default';
    }

    // ── Event Handlers ──
    document.getElementById('btn-refresh').addEventListener('click', () => loadData());

    document.getElementById('btn-export').addEventListener('click', () => {
        const json = JSON.stringify(diagData, null, 2);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `diagnostics_export_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
    });

    document.getElementById('btn-clear').addEventListener('click', () => {
        if (!confirm('Clear all diagnostics history?')) return;
        chrome.runtime.sendMessage({ type: 'CLEAR_DIAG_DATA' }, () => {
            diagData = { tasks: [], plumxResults: [] };
            selectedTaskId = null;
            render();
        });
    });

    filterCitationsEl.addEventListener('change', (e) => {
        filterCitations = e.target.value;
        renderTaskDetail();
    });

    filterDetailEl.addEventListener('change', (e) => {
        filterDetail = e.target.value;
        renderTaskDetail();
    });

    // Live updates from background
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type === 'STATE_UPDATE') {
            // Reload data to pick up latest changes
            loadData();
        }
    });

    // ── Initial load ──
    loadData();
});
