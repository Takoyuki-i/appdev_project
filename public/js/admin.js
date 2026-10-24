'use strict';

/*
 * Admin dashboard frontend only.
 * Expected Express endpoints:
 *   GET  /api/admin/event-proposals?status=pending|approved|rejected|all
 *        -> { events: [{ id, title, description, organizerName, category, venue,
 *                       eventDate, startTime, endTime, status, submittedAt,
 *                       reviewNote }] }
 *   POST /api/admin/event-proposals/:id/decision
 *        JSON body: { status: "approved" | "rejected", reviewNote: "..." }
 *        -> { success: true, event: { ... } }
 *   GET  /api/events -> FullCalendar-compatible array of APPROVED events only
 *
 * The server must authenticate the session and verify the admin role for the
 * admin endpoints. Do not use localStorage or client-side role flags as security.
 */
(() => {
  const $ = (selector) => document.querySelector(selector);
  const state = { status: 'pending', events: [], activeEvent: null, decision: null, calendar: null };
  const els = {
    proposalList: $('#proposal-list'), search: $('#proposal-search'),
    pendingCount: $('#pending-count'), pendingStat: $('#stat-pending'),
    approvedStat: $('#stat-approved'), rejectedStat: $('#stat-rejected'),
    approvalsView: $('#approvals-view'), calendarView: $('#calendar-view'),
    title: $('#page-title'), subtitle: $('#page-subtitle'), dialog: $('#decision-dialog'),
    form: $('#decision-form'), dialogTitle: $('#dialog-title'), dialogDescription: $('#dialog-description'),
    dialogMark: $('#dialog-mark'), reasonLabel: $('#reason-label'), reason: $('#decision-reason'),
    dialogError: $('#dialog-error'), confirm: $('#confirm-decision'), toast: $('#toast')
  };

  const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  const statusText = (status) => ({ pending: 'Pending review', approved: 'Approved', rejected: 'Declined' }[status] || 'Pending review');
  const dateLabel = (value) => {
    if (!value) return 'Date not provided';
    const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
    return Number.isNaN(date.getTime()) ? safe(value) : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  };
  const timeLabel = (value) => {
    if (!value) return '';
    const [hour, minute] = String(value).split(':').map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return safe(value);
    const d = new Date(); d.setHours(hour, minute, 0, 0);
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };
  const normalizedStatus = (event) => {
    const status = String(event.status || 'pending').toLowerCase();
    if (status === 'declined') return 'rejected';
    return ['pending', 'approved', 'rejected'].includes(status) ? status : 'pending';
  };
  const getTitle = (event) => event.title || event.eventTitle || 'Untitled event';
  const getOrganizer = (event) => event.organizerName || event.organizer || event.club || 'Organizer not specified';
  const getDate = (event) => event.eventDate || event.date || event.start || '';
  const getTime = (event) => {
    const start = event.startTime || event.start_time || (typeof event.start === 'string' && event.start.includes('T') ? event.start.slice(11, 16) : event.start);
    const end = event.endTime || event.end_time || event.end;
    if (typeof start === 'string' && start.includes('T')) return start;
    return [timeLabel(start), timeLabel(end)].filter(Boolean).join(' – ');
  };

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
      ...options
    });
    const type = response.headers.get('content-type') || '';
    const body = type.includes('application/json') ? await response.json() : null;
    if (response.status === 401 || response.status === 403) {
      throw new Error(body?.error || body?.message || 'Your session may have expired or you do not have admin permission. Please sign in again.');
    }
    if (!response.ok) throw new Error(body?.error || body?.message || `Request failed (${response.status}).`);
    if (!body) throw new Error('The server did not return JSON. Check that the requested Express API route exists.');
    return body;
  }

  let toastTimer;
  function toast(message, isError = false) {
    els.toast.textContent = message;
    els.toast.classList.toggle('error', isError);
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3600);
  }

  function getFilteredEvents() {
    const query = els.search.value.trim().toLowerCase();
    return state.events.filter((event) => normalizedStatus(event) === state.status).filter((event) => {
      if (!query) return true;
      return [getTitle(event), getOrganizer(event), event.venue, event.category, event.description]
        .some((value) => String(value || '').toLowerCase().includes(query));
    }).sort((a, b) => String(getDate(a)).localeCompare(String(getDate(b))));
  }

  function renderStats() {
    const count = (status) => state.events.filter((event) => normalizedStatus(event) === status).length;
    const pending = count('pending');
    els.pendingCount.textContent = String(pending);
    els.pendingStat.textContent = String(pending);
    els.approvedStat.textContent = String(count('approved'));
    els.rejectedStat.textContent = String(count('rejected'));
  }

  function renderProposals() {
    const events = getFilteredEvents();
    if (!events.length) {
      const message = els.search.value.trim() ? 'Try another search term.' : ({
        pending: 'There are no event proposals waiting for review.',
        approved: 'No approved proposals were returned.',
        rejected: 'No declined proposals were returned.'
      }[state.status]);
      els.proposalList.innerHTML = `<div class="empty-state"><span class="empty-icon">✓</span><strong>${els.search.value.trim() ? 'No matching proposals' : 'All caught up'}</strong><span>${safe(message)}</span></div>`;
      return;
    }
    els.proposalList.innerHTML = events.map((event) => {
      const status = normalizedStatus(event);
      const date = dateLabel(getDate(event));
      const time = getTime(event);
      const duration = Number.parseInt(event.duration, 10);
      const durationLabel = Number.isInteger(duration) && duration > 0 ? `${duration} day${duration === 1 ? '' : 's'}` : '';
      const description = event.description || event.details || event.purpose || '';
      const category = event.category || event.cat || 'Uncategorized';
      const venue = event.venue || 'Venue not specified';
      const submitted = event.submittedAt || event.createdAt || event.created_at;
      const submittedLabel = submitted ? dateLabel(String(submitted).slice(0, 10)) : '';
      const actions = status === 'pending'
        ? `<button class="button approve" type="button" data-decision="approved" data-id="${safe(event.id)}">✓ Approve</button><button class="button decline" type="button" data-decision="rejected" data-id="${safe(event.id)}">× Decline</button>`
        : `<span class="status-badge ${status}">${safe(statusText(status))}</span>`;
      const note = event.reviewNote || event.review_note || '';
      return `<article class="proposal-card">
        <div class="proposal-main">
          <div class="proposal-topline"><span class="status-badge ${status}">${safe(statusText(status))}</span><h3>${safe(getTitle(event))}</h3></div>
          ${description ? `<p class="proposal-description">${safe(description)}</p>` : '<p class="proposal-description">No description was provided.</p>'}
          <div class="proposal-meta">
            <span>◷ <b>${safe(date)}${time ? ` · ${safe(time)}` : ''}${durationLabel ? ` · ${safe(durationLabel)}` : ''}</b></span>
            <span>⌖ <b>${safe(venue)}</b></span>
            <span>▤ <b>${safe(category)}</b></span>
            <span>♙ <b>${safe(getOrganizer(event))}</b></span>
            ${submittedLabel ? `<span>Submitted <b>${safe(submittedLabel)}</b></span>` : ''}
          </div>
          ${status === 'rejected' && note ? `<p class="proposal-description"><b>Decline note:</b> ${safe(note)}</p>` : ''}
        </div>
        <div class="proposal-actions">${actions}</div>
      </article>`;
    }).join('');
  }

  async function loadProposals() {
    els.proposalList.innerHTML = '<div class="loading-state"><span class="spinner"></span> Loading event proposals…</div>';
    try {
      const payload = await request(`/api/admin/event-proposals?status=all`);
      state.events = Array.isArray(payload) ? payload : (Array.isArray(payload.events) ? payload.events : []);
      renderStats(); renderProposals();
    } catch (error) {
      els.proposalList.innerHTML = `<div class="empty-state"><span class="empty-icon">!</span><strong>Could not load event proposals</strong><span>${safe(error.message)}</span><span>Check the admin API route and database connection in Express.</span><button class="button secondary" type="button" id="retry-load">Try again</button></div>`;
      $('#retry-load')?.addEventListener('click', loadProposals);
      renderStats();
    }
  }

  function openDecision(id, status) {
    const event = state.events.find((item) => String(item.id) === String(id));
    if (!event) return;
    state.activeEvent = event;
    state.decision = status;
    els.reason.value = '';
    els.dialogError.textContent = '';
    const approve = status === 'approved';
    els.dialogMark.textContent = approve ? '✓' : '×';
    els.dialogTitle.textContent = approve ? 'Approve this event?' : 'Decline this proposal?';
    els.dialogDescription.textContent = approve
      ? `“${getTitle(event)}” will become approved and can appear on the public calendar.`
      : `“${getTitle(event)}” will be declined and will not appear on the public calendar.`;
    els.reasonLabel.hidden = approve;
    els.reason.hidden = approve;
    els.confirm.textContent = approve ? 'Approve event' : 'Decline proposal';
    els.confirm.className = `button ${approve ? 'primary' : 'decline'}`;
    els.dialog.showModal();
  }

  async function submitDecision(event) {
    event.preventDefault();
    if (!state.activeEvent || !state.decision) return;
    const id = state.activeEvent.id;
    els.confirm.disabled = true;
    els.confirm.textContent = 'Saving…';
    els.dialogError.textContent = '';
    try {
      await request(`/api/admin/event-proposals/${encodeURIComponent(id)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ status: state.decision, reviewNote: els.reason.value.trim() })
      });
      els.dialog.close();
      toast(state.decision === 'approved' ? 'Event approved. It can now appear on the public calendar.' : 'Event proposal declined.');
      await loadProposals();
      if (state.calendar) state.calendar.refetchEvents();
    } catch (error) {
      els.dialogError.textContent = error.message;
    } finally {
      els.confirm.disabled = false;
      els.confirm.textContent = state.decision === 'approved' ? 'Approve event' : 'Decline proposal';
    }
  }

  function setView(view) {
    const calendar = view === 'calendar';
    els.approvalsView.hidden = calendar;
    els.calendarView.hidden = !calendar;
    document.querySelectorAll('[data-view]').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
    els.title.textContent = calendar ? 'Events calendar' : 'Event proposals';
    els.subtitle.textContent = calendar ? 'A shared view of events that have been approved for publication.' : 'Review submissions before they appear on the public calendar.';
    if (calendar) {
      initializeCalendar();
      requestAnimationFrame(() => state.calendar?.updateSize());
    }
  }

  function initializeCalendar() {
    const calendarEl = $('#admin-calendar');
    if (state.calendar || !calendarEl || !window.FullCalendar) return;
    state.calendar = new FullCalendar.Calendar(calendarEl, {
      initialView: 'dayGridMonth',
      height: 'auto',
      fixedWeekCount: false,
      headerToolbar: { left: 'prev,next today', center: 'title', right: 'dayGridMonth,timeGridWeek,listMonth' },
      buttonText: { today: 'Today', month: 'Month', week: 'Week', list: 'Agenda' },
      events: async (_info, success, failure) => {
        try {
          const payload = await request('/api/events');
          const events = Array.isArray(payload) ? payload : (Array.isArray(payload.events) ? payload.events : []);
          success(events.map((event) => ({
            id: event.id,
            title: getTitle(event),
            start: event.start || (event.eventDate || event.date ? `${event.eventDate || event.date}${event.startTime || event.start_time ? `T${event.startTime || event.start_time}` : ''}` : undefined),
            end: event.end || (event.eventDate || event.date ? `${event.eventDate || event.date}${event.endTime || event.end_time ? `T${event.endTime || event.end_time}` : ''}` : undefined),
            extendedProps: { venue: event.venue || '', category: event.category || event.cat || '' }
          })));
        } catch (error) { failure(error); toast(`Calendar could not load: ${error.message}`, true); }
      },
      eventClick: (info) => {
        const venue = info.event.extendedProps.venue;
        toast(`${info.event.title}${venue ? ` · ${venue}` : ''}`);
      }
    });
    state.calendar.render();
  }

  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
  document.querySelectorAll('[data-status]').forEach((button) => button.addEventListener('click', () => {
    state.status = button.dataset.status;
    document.querySelectorAll('[data-status]').forEach((item) => item.classList.toggle('active', item === button));
    renderProposals();
  }));
  els.proposalList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-decision][data-id]');
    if (button) openDecision(button.dataset.id, button.dataset.decision);
  });
  els.search.addEventListener('input', renderProposals);
  els.form.addEventListener('submit', submitDecision);
  $('#cancel-decision').addEventListener('click', () => els.dialog.close());
  $('#refresh-button').addEventListener('click', loadProposals);
  els.dialog.addEventListener('click', (event) => { if (event.target === els.dialog) els.dialog.close(); });
  loadProposals();
})();
