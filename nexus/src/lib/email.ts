import { Resend } from 'resend';
import { formatHST } from './utils/formatHST';
import { UploadStatus } from '@/types/database';
import { APP_NAME } from './constants';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

function getResendClient(): Resend | null {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

interface SendEmailParams {
  to: string[];
  subject: string;
  text: string;
}

async function sendEmail({ to, subject, text }: SendEmailParams) {
  const resend = getResendClient();
  if (!resend) {
    console.warn('RESEND_API_KEY not set, skipping email');
    return;
  }

  try {
    await resend.emails.send({
      from: `${APP_NAME} <noreply@resend.dev>`,
      to,
      subject,
      text,
    });
  } catch (error) {
    console.error('Failed to send email:', error);
    throw error;
  }
}

export async function sendNewUploadEmail(params: {
  recipients: string[];
  packagingName: string;
  packagingId: string;
  uploaderName: string;
  timestamp: string;
}) {
  const { recipients, packagingName, packagingId, uploaderName, timestamp } = params;

  await sendEmail({
    to: recipients,
    subject: `New Artwork File Uploaded - ${packagingName}`,
    text: `New artwork files have been uploaded by ${uploaderName}.

Packaging: ${packagingName}
Uploaded by: ${uploaderName}
Time: ${formatHST(timestamp)}

View and download files: ${APP_URL}/packaging/${packagingId}`,
  });
}

export async function sendStatusChangeEmail(params: {
  recipients: string[];
  packagingName: string;
  packagingId: string;
  newStatus: UploadStatus;
  changedByName: string;
  timestamp: string;
}) {
  const { recipients, packagingName, packagingId, newStatus, changedByName, timestamp } = params;

  const statusLabel = newStatus.charAt(0).toUpperCase() + newStatus.slice(1);

  await sendEmail({
    to: recipients,
    subject: `Status Changed to ${statusLabel} - ${packagingName}`,
    text: `The status has been changed by ${changedByName}.

Packaging: ${packagingName}
New Status: ${statusLabel}
Changed by: ${changedByName}
Time: ${formatHST(timestamp)}

View details: ${APP_URL}/packaging/${packagingId}`,
  });
}

export async function sendNoteAddedEmail(params: {
  recipients: string[];
  packagingName: string;
  packagingId: string;
  noteText: string;
  addedByName: string;
  timestamp: string;
}) {
  const { recipients, packagingName, packagingId, noteText, addedByName, timestamp } = params;

  await sendEmail({
    to: recipients,
    subject: `Note Added - ${packagingName}`,
    text: `A note has been added by ${addedByName}.

Packaging: ${packagingName}
Note: ${noteText}
Added by: ${addedByName}
Time: ${formatHST(timestamp)}

View details: ${APP_URL}/packaging/${packagingId}`,
  });
}

/**
 * Card setup email. Unlike sendEmail this THROWS on missing config or a Resend
 * error: staff clicked "Email link" and must know if it did not go out.
 * Contains the link only, never card data.
 */
export async function sendCardSetupEmail(p: {
  to: string;
  organizationName: string;
  customerName: string;
  url: string;
  expiresAt: string;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Email is not set up (RESEND_API_KEY is missing).');
  const from = process.env.CUSTOMER_EMAIL_FROM;
  if (!from) throw new Error('Email is not set up (CUSTOMER_EMAIL_FROM is missing).');

  const date = new Date(p.expiresAt).toLocaleDateString('en-US', {
    timeZone: 'Pacific/Honolulu',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const { error } = await new Resend(apiKey).emails.send({
    from,
    to: p.to,
    subject: `Add a card for ${p.organizationName}`,
    text: `Hello ${p.customerName},

${p.organizationName} has asked you to save a card on file. Please use the secure link below to add one:

${p.url}

This link expires on ${date}.`,
  });
  if (error) throw new Error(`Could not send the email: ${error.message}`);
}

const CARD_BRAND_NAMES: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
};

/** Staff notice that a customer saved a card. Goes to CARD_SAVED_NOTIFY_EMAIL (default below). */
export async function sendCardSavedNotification(p: {
  customerName: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  savedAt: Date;
}): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('Email is not set up (RESEND_API_KEY is missing).');
  const from = process.env.CUSTOMER_EMAIL_FROM;
  if (!from) throw new Error('Email is not set up (CUSTOMER_EMAIL_FROM is missing).');
  const to = process.env.CARD_SAVED_NOTIFY_EMAIL || 'fundraisers@hawaiicandyfactory.com';

  const brand = CARD_BRAND_NAMES[p.brand] ?? p.brand.charAt(0).toUpperCase() + p.brand.slice(1);
  const exp = `${String(p.expMonth).padStart(2, '0')}/${String(p.expYear % 100).padStart(2, '0')}`;
  const date = p.savedAt.toLocaleDateString('en-US', {
    timeZone: 'Pacific/Honolulu',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const { error } = await new Resend(apiKey).emails.send({
    from,
    to,
    subject: `${p.customerName} saved Payment Method [NEXUS]`,
    text: `${p.customerName}
${brand} •••• ${p.last4}, exp ${exp}
saved ${date}`,
  });
  if (error) throw new Error(`Could not send the email: ${error.message}`);
}
