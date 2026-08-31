import React from 'react';
import { STATUS_LABELS } from '../api.js';
import { t } from '../i18n.jsx';

export default function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{t(STATUS_LABELS[status] || status)}</span>;
}
