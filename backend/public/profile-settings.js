let profileData = null;

document.addEventListener('DOMContentLoaded', loadProfile);

async function loadProfile() {
  try {
    const res = await fetch('/api/auto-apply/profile');
    profileData = await res.json();
    populateForm(profileData);
    document.getElementById('loading').style.display = 'none';
    document.getElementById('profileForm').style.display = 'block';
  } catch (e) {
    document.getElementById('loading').textContent = 'Failed to load profile: ' + e.message;
  }
}

function populateForm(data) {
  const p = data.personal || {};
  const addr = p.address || {};
  setValue('p_firstName', p.firstName);
  setValue('p_lastName', p.lastName);
  setValue('p_email', p.email);
  setValue('p_phone', p.phone);
  setValue('p_linkedin', p.linkedin);
  setValue('p_github', p.github);
  setValue('p_portfolio', p.portfolio);
  setValue('p_street', addr.street);
  setValue('p_city', addr.city);
  setValue('p_state', addr.state);
  setValue('p_zip', addr.zip);
  setValue('p_country', addr.country);

  const w = data.workAuthorization || {};
  setValue('w_visaStatus', w.visaStatus);
  setChecked('w_authorized', w.authorized);
  setChecked('w_requireSponsorship', w.requireSponsorship);
  setChecked('w_willingToRelocate', w.willingToRelocate);
  setChecked('w_workRemote', w.workRemote);
  setChecked('w_workHybrid', w.workHybrid);
  setChecked('w_workOnsite', w.workOnsite);

  const e = data.employment || {};
  setValue('e_currentEmployer', e.currentEmployer);
  setValue('e_currentTitle', e.currentTitle);
  setValue('e_expectedSalary', e.expectedSalary);
  setValue('e_expectedSalaryMin', e.expectedSalaryMin);
  setValue('e_expectedSalaryMax', e.expectedSalaryMax);
  setValue('e_yearsOfExperience', e.yearsOfExperience);
  setValue('e_noticePeriod', e.noticePeriod);
  setValue('e_startDate', e.startDate);

  const ed = data.education || {};
  setValue('ed_degree', ed.degree);
  setValue('ed_field', ed.field);
  setValue('ed_school', ed.school);
  setValue('ed_graduationYear', ed.graduationYear);
  setValue('ed_gpa', ed.gpa);

  const d = data.demographics || {};
  setValue('d_gender', d.gender);
  setValue('d_ethnicity', d.ethnicity);
  setChecked('d_veteran', d.veteran);
  setChecked('d_disability', d.disability);
  setChecked('d_hispanicLatino', d.hispanicLatino);

  renderWorkHistory(data.workHistory || []);

  const c = data.commonAnswers || {};
  setValue('c_coverLetter', c.coverLetter);
  setValue('c_whyThisRole', c.whyThisRole);
  setValue('c_availability', c.availability);
  setValue('c_salaryExpectation', c.salaryExpectation);
  setValue('c_references', c.references);
}

function renderWorkHistory(entries) {
  const container = document.getElementById('workHistoryList');
  container.innerHTML = '';
  entries.forEach((entry, idx) => {
    container.appendChild(createWorkEntryEl(entry, idx));
  });
}

function createWorkEntryEl(entry, idx) {
  const div = document.createElement('div');
  div.className = 'work-entry';
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="work-entry-header">
      <strong>${entry.company || 'New Job'} — ${entry.title || ''}</strong>
      <button class="remove-btn" onclick="removeWorkEntry(${idx})">Remove</button>
    </div>
    <div class="field-row">
      <div class="field-group"><label>Company</label><input class="wh-company" value="${esc(entry.company)}" /></div>
      <div class="field-group"><label>Title</label><input class="wh-title" value="${esc(entry.title)}" /></div>
    </div>
    <div class="field-row">
      <div class="field-group"><label>Start Date</label><input class="wh-start" value="${esc(entry.startDate)}" /></div>
      <div class="field-group"><label>End Date</label><input class="wh-end" value="${esc(entry.endDate)}" /></div>
    </div>
    <div class="field-row">
      <div class="field-group"><label>Location</label><input class="wh-location" value="${esc(entry.location)}" /></div>
      <div class="field-group">
        <label>Current</label>
        <div class="toggle-row"><input type="checkbox" class="wh-current" ${entry.current ? 'checked' : ''} /><span>Currently working here</span></div>
      </div>
    </div>
    <div class="field-group"><label>Description</label><textarea class="wh-desc">${esc(entry.description)}</textarea></div>
  `;
  return div;
}

function addWorkEntry() {
  const container = document.getElementById('workHistoryList');
  const idx = container.children.length;
  container.appendChild(createWorkEntryEl({
    company: '', title: '', startDate: '', endDate: '', current: false, location: '', description: ''
  }, idx));
}

function removeWorkEntry(idx) {
  const container = document.getElementById('workHistoryList');
  const entries = container.querySelectorAll('.work-entry');
  if (entries[idx]) entries[idx].remove();
}

function collectFormData() {
  const stateInput = getValue('p_state');
  const stateCode = stateInput.length === 2 ? stateInput.toUpperCase() : '';

  const data = {
    personal: {
      fullName: getValue('p_firstName') + ' ' + getValue('p_lastName'),
      firstName: getValue('p_firstName'),
      lastName: getValue('p_lastName'),
      email: getValue('p_email'),
      phone: getValue('p_phone'),
      phoneFormatted: formatPhone(getValue('p_phone')),
      linkedin: getValue('p_linkedin'),
      github: getValue('p_github'),
      portfolio: getValue('p_portfolio'),
      address: {
        street: getValue('p_street'),
        city: getValue('p_city'),
        state: getValue('p_state'),
        stateCode: stateCode,
        zip: getValue('p_zip'),
        country: getValue('p_country'),
        countryCode: getValue('p_country') === 'United States' ? 'US' : ''
      }
    },
    workAuthorization: {
      authorized: getChecked('w_authorized'),
      requireSponsorship: getChecked('w_requireSponsorship'),
      visaStatus: getValue('w_visaStatus'),
      willingToRelocate: getChecked('w_willingToRelocate'),
      workRemote: getChecked('w_workRemote'),
      workHybrid: getChecked('w_workHybrid'),
      workOnsite: getChecked('w_workOnsite')
    },
    employment: {
      currentEmployer: getValue('e_currentEmployer'),
      currentTitle: getValue('e_currentTitle'),
      expectedSalary: getValue('e_expectedSalary'),
      expectedSalaryMin: getValue('e_expectedSalaryMin'),
      expectedSalaryMax: getValue('e_expectedSalaryMax'),
      noticePeriod: getValue('e_noticePeriod'),
      yearsOfExperience: getValue('e_yearsOfExperience'),
      startDate: getValue('e_startDate')
    },
    education: {
      degree: getValue('ed_degree'),
      field: getValue('ed_field'),
      school: getValue('ed_school'),
      graduationYear: getValue('ed_graduationYear'),
      gpa: getValue('ed_gpa')
    },
    demographics: {
      gender: getValue('d_gender'),
      ethnicity: getValue('d_ethnicity'),
      veteran: getChecked('d_veteran'),
      disability: getChecked('d_disability'),
      hispanicLatino: getChecked('d_hispanicLatino')
    },
    workHistory: collectWorkHistory(),
    commonAnswers: {
      coverLetter: getValue('c_coverLetter'),
      whyThisRole: getValue('c_whyThisRole'),
      availability: getValue('c_availability'),
      salaryExpectation: getValue('c_salaryExpectation'),
      references: getValue('c_references')
    }
  };

  return data;
}

function collectWorkHistory() {
  const entries = document.querySelectorAll('.work-entry');
  return Array.from(entries).map(el => ({
    company: el.querySelector('.wh-company')?.value || '',
    title: el.querySelector('.wh-title')?.value || '',
    startDate: el.querySelector('.wh-start')?.value || '',
    endDate: el.querySelector('.wh-end')?.value || '',
    current: el.querySelector('.wh-current')?.checked || false,
    location: el.querySelector('.wh-location')?.value || '',
    description: el.querySelector('.wh-desc')?.value || ''
  }));
}

async function saveProfile() {
  const data = collectFormData();
  try {
    const res = await fetch('/api/auto-apply/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (res.ok) {
      const msg = document.getElementById('saveMsg');
      msg.style.display = 'inline';
      setTimeout(() => msg.style.display = 'none', 3000);
    } else {
      alert('Failed to save profile');
    }
  } catch (e) {
    alert('Failed to save: ' + e.message);
  }
}

// Helpers
function setValue(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val || '';
}
function getValue(id) {
  const el = document.getElementById(id);
  return el ? el.value.trim() : '';
}
function setChecked(id, val) {
  const el = document.getElementById(id);
  if (el) el.checked = !!val;
}
function getChecked(id) {
  const el = document.getElementById(id);
  return el ? el.checked : false;
}
function esc(str) {
  if (!str) return '';
  return str.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function formatPhone(phone) {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  return phone || '';
}
