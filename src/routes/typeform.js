const express = require('express');
const router = express.Router();
const { sendDiscordMessage, createEmbed, COLORS } = require('../utils/discord');
const { sendSlackMessage } = require('../utils/slack');
const axios = require('axios');

const processedEmails = new Map();
const DEDUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function isDuplicateEmail(email) {
  if (!email) return false;
  const now = Date.now();
  if (processedEmails.has(email)) {
    const timestamp = processedEmails.get(email);
    if (now - timestamp < DEDUP_WINDOW_MS) {
      console.log(`Duplicate email blocked: ${email}`);
      return true;
    }
  }
  processedEmails.set(email, now);
  for (const [k, t] of processedEmails.entries()) {
    if (now - t > DEDUP_WINDOW_MS) processedEmails.delete(k);
  }
  return false;
}

function abbreviateTitle(title) {
  const map = {
    'are you a permanent resident of the uk or us': 'Permanent Resident?',
    'what industry do you currently work in': 'Industry',
    'what is your current job title or role': 'Current Job',
    'how much are you currently earning per year': 'Income',
    'why do you want to break into tech sales': 'Why Tech Sales',
    'have you already applied for or interviewed for any tech sales roles': 'Already Applying?',
    "what's your biggest concern or hesitation about making this career switch": 'Concerns / Hesitations',
    'how soon are you looking to make this transition': 'Timeline',
    'the investment for our program is': 'Investment',
    'to be approved for a 12-month payment plan': 'Credit Score',
    'now, book your tech sales career coaching call': 'UQ Calendar Booking',
    'schedule your tech sales career coaching call below': 'Main Calendar Booking',
    'how did you hear about entr tech': 'Source',
    'first name': 'First Name',
    'last name': 'Last Name',
    'phone number': 'Phone',
    'email': 'Email',
  };
  const lower = title.toLowerCase();
  for (const [key, val] of Object.entries(map)) {
    if (lower.includes(key)) return val;
  }
  return title;
}

function isUQCalendarUrl(url) {
  const lower = url.toLowerCase();
  return lower.includes('uq') || lower.includes('uq-career-coaching');
}

async function createGHLContact(contactData) {
  try {
    const response = await axios.post(
      'https://services.leadconnectorhq.com/contacts/',
      contactData,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log('GHL contact created:', response.data?.contact?.id);
    return response.data?.contact;
  } catch (err) {
    if (err.response?.status === 400 && err.response?.data?.meta?.contactId) {
      console.log('GHL contact already exists:', err.response.data.meta.contactId);
      return { id: err.response.data.meta.contactId };
    }
    console.error('GHL contact error:', err.response?.status, JSON.stringify(err.response?.data));
    return null;
  }
}

async function createGHLOpportunity(contact, stageId, monetaryValue, source) {
  try {
    const pipelineId = process.env.GHL_PIPELINE_ID;
    if (!pipelineId || !stageId || !contact?.id) return null;

    const name = `${contact.firstName || ''} ${contact.lastName || ''}`.trim() || contact.email || 'New Lead';

    const response = await axios.post(
      'https://services.leadconnectorhq.com/opportunities/',
      {
        pipelineId,
        pipelineStageId: stageId,
        contactId: contact.id,
        name,
        locationId: process.env.GHL_LOCATION_ID,
        status: 'open',
        monetaryValue,
        source,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
          'Content-Type': 'application/json',
          'Version': '2021-07-28'
        }
      }
    );
    console.log('GHL opportunity created:', response.data?.opportunity?.id);
    return response.data?.opportunity;
  } catch (err) {
    console.error('GHL opportunity error:', err.response?.status, JSON.stringify(err.response?.data));
    return null;
  }
}

async function findAndUpdateOpportunityStage(contactId, stageId) {
  try {
    const pipelineId = process.env.GHL_PIPELINE_ID;
    if (!pipelineId || !stageId || !contactId) return null;

    const response = await axios.get(
      `https://services.leadconnectorhq.com/opportunities/search?location_id=${process.env.GHL_LOCATION_ID}&contact_id=${contactId}`,
      {
        headers: {
          'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
          'Version': '2021-07-28'
        }
      }
    );

    const opportunities = response.data?.opportunities || [];
    const opportunity = opportunities.find(o => o.pipelineId === pipelineId);

    if (opportunity) {
      await axios.put(
        `https://services.leadconnectorhq.com/opportunities/${opportunity.id}`,
        { pipelineStageId: stageId },
        {
          headers: {
            'Authorization': `Bearer ${process.env.GHL_API_KEY}`,
            'Content-Type': 'application/json',
            'Version': '2021-07-28'
          }
        }
      );
      console.log('GHL opportunity stage updated to booked');
      return opportunity;
    }
    return null;
  } catch (err) {
    console.error('GHL opportunity update error:', err.response?.status, JSON.stringify(err.response?.data));
    return null;
  }
}

router.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    const answers = payload.form_response?.answers || [];
    const fields_def = payload.form_response?.definition?.fields || [];
    const hidden = payload.form_response?.hidden || {};

    const discordFields = [];
    let isQualified = false;
    let isPremiumLead = false;
    let hasHighIncome = false;
    let hasCalendly = false;
    let bookedUQCalendar = false;
    let firstName = '';
    let lastName = '';
    let phone = '';
    let email = '';
    let source = '';

    const now = new Date().toLocaleDateString('en-GB');
    discordFields.push({ name: 'Time', value: now, inline: true });

    answers.forEach((answer, index) => {
      const fieldDef = fields_def[index];
      const rawTitle = fieldDef?.title || `Question ${index + 1}`;
      const fieldTitle = abbreviateTitle(rawTitle);
      let value = '';

      switch (answer.type) {
        case 'text':
          value = answer.text || '';
          break;
        case 'email':
          value = answer.email || '';
          email = value;
          break;
        case 'phone_number':
          value = answer.phone_number || '';
          phone = value;
          break;
        case 'choice':
          value = answer.choice?.label || '';
          break;
        case 'choices':
          value = answer.choices?.labels?.join(', ') || '';
          break;
        case 'boolean':
          value = answer.boolean ? 'Yes' : 'No';
          break;
        case 'number':
          value = String(answer.number) || '';
          break;
        case 'calendly':
          hasCalendly = true;
          value = answer.url || 'Call Booked ✅';
          if (isUQCalendarUrl(value)) bookedUQCalendar = true;
          break;
        case 'url':
          value = answer.url || '';
          if (value.includes('calendly.com') && value.includes('invitees')) {
            hasCalendly = true;
            if (isUQCalendarUrl(value)) bookedUQCalendar = true;
          }
          break;
        default:
          value = answer.url || answer.text || answer.email || '';
          if (value && value.includes('calendly.com') && value.includes('invitees')) {
            hasCalendly = true;
            if (isUQCalendarUrl(value)) bookedUQCalendar = true;
          }
      }

      const titleLower = rawTitle.toLowerCase();
      if (titleLower.includes('first name')) firstName = value;
      if (titleLower.includes('last name')) lastName = value;
      if (titleLower.includes('how did you hear')) source = value;

      // Income check — £35k+ triggers PREMIUM QUALIFIED immediately
      if (titleLower.includes('earning per year') || titleLower.includes('currently earning')) {
        const valueLower = value.toLowerCase();
        if (
          valueLower.includes('35k') ||
          valueLower.includes('45k') ||
          valueLower.includes('60k') ||
          valueLower.includes('over') ||
          valueLower.includes('£35') ||
          valueLower.includes('£45') ||
          valueLower.includes('£60')
        ) {
          hasHighIncome = true;
        }
      }

      // Investment check
      if (titleLower.includes('invest') || titleLower.includes('£3500') || titleLower.includes('payment plan')) {
        const valueLower = value.toLowerCase();
        if (valueLower.includes('yes') || valueLower.includes('can invest')) {
          isQualified = true;
        }
      }

      // Credit score check
      if (titleLower.includes('credit score') || titleLower.includes('experian')) {
        const scoreLower = value.toLowerCase();
        if (
          scoreLower.includes('800') ||
          scoreLower.includes('701') ||
          scoreLower.includes('700') ||
          scoreLower.includes('600 - 700') ||
          scoreLower.includes('600+')
        ) {
          if (isQualified) isPremiumLead = true;
        }
      }

      // Show booking link in Discord
      if (fieldTitle === 'UQ Calendar Booking' || fieldTitle === 'Main Calendar Booking') {
        if (value && value.includes('calendly.com')) {
          discordFields.push({
            name: 'Call Booking',
            value: String(value).substring(0, 1024),
            inline: true
          });
        }
        return;
      }

      if (value) {
        discordFields.push({
          name: fieldTitle.substring(0, 256),
          value: String(value).substring(0, 1024),
          inline: true
        });
      }
    });

    // Add UTM data
    if (hidden && Object.keys(hidden).length > 0) {
      const utmLines = Object.entries(hidden)
        .filter(([k, v]) => v)
        .map(([k, v]) => `**${k}:** ${v}`)
        .join('\n');
      if (utmLines) {
        discordFields.push({ name: 'ATTRIBUTION', value: utmLines, inline: false });
      }
    }

    if (!hasCalendly) {
      hasCalendly = discordFields.some(f =>
        f.value && f.value.includes('calendly.com') && f.value.includes('invitees')
      );
    }

    // Colour coding:
    // PREMIUM QUALIFIED = income £35k+ OR (investment yes + credit 600+) — NOT UQ calendar
    // QUALIFIED = investment yes + credit 600+
    // UNQUALIFIED = everything else
    const isPremiumQualified = (hasHighIncome || isPremiumLead) && !bookedUQCalendar;
    const monetaryValue = isPremiumQualified ? 3500 : isQualified ? 1997 : 0;
    const opportunitySource = isPremiumQualified ? 'premium-qualified' : isQualified ? 'qualified' : 'unqualified';

    // Always create GHL contact for ALL leads
    const contact = await createGHLContact({
      firstName,
      lastName,
      email,
      phone,
      locationId: process.env.GHL_LOCATION_ID,
      source: source || 'typeform',
      tags: ['typeform-lead'],
    });

    if (hasCalendly) {
      // Full form with booking — move opportunity
      if (contact?.id) {
        const existing = await findAndUpdateOpportunityStage(
          contact.id,
          process.env.GHL_PIPELINE_BOOKED_STAGE_ID
        );
        if (!existing) {
          await createGHLOpportunity(
            contact,
            process.env.GHL_PIPELINE_BOOKED_STAGE_ID,
            monetaryValue,
            opportunitySource
          );
        }
      }

      // Always send call booked regardless of dedup
      let color, title;
      if (isPremiumQualified) {
        color = COLORS.GOLD;
        title = '🥇 New Call Booked - PREMIUM QUALIFIED';
      } else if (isQualified) {
        color = COLORS.GREEN;
        title = '🟢 New Call Booked - QUALIFIED';
      } else {
        color = COLORS.BLUE;
        title = '📞 New Call Booked - UNQUALIFIED';
      }
      const embed = createEmbed(title, discordFields, color);
      await sendDiscordMessage(process.env.DISCORD_WEBHOOK_BOOKED_CALLS, embed);
      await sendSlackMessage(process.env.SLACK_WEBHOOK_BOOKED_CALLS, embed);

    } else {
      // Partial submission — send new lead
      // Key fix: always send if hasHighIncome (over £35k) even without investment answer
      // Use dedup to prevent spam but NOT to block qualified leads
      const isPartialQualified = hasHighIncome || isQualified || isPremiumQualified;

      if (!isDuplicateEmail(email)) {
        // Create opportunity for ALL leads
        if (contact?.id) {
          await createGHLOpportunity(
            contact,
            process.env.GHL_PIPELINE_STAGE_ID,
            monetaryValue,
            opportunitySource
          );
        }

        let color, title;
        if (isPremiumQualified) {
          color = COLORS.GOLD;
          title = '🥇 New Lead Optin - PREMIUM QUALIFIED';
        } else if (isQualified) {
          color = COLORS.GREEN;
          title = '🟢 New Lead Optin - QUALIFIED';
        } else if (hasHighIncome) {
          // Partial — income over £35k but no investment answer yet
          color = COLORS.GOLD;
          title = '🥇 New Lead Optin - PREMIUM QUALIFIED';
        } else {
          color = COLORS.BLUE;
          title = '📞 New Lead Optin - UNQUALIFIED';
        }

        const embed = createEmbed(title, discordFields, color);
        await sendDiscordMessage(process.env.DISCORD_WEBHOOK_NEW_LEADS, embed);
        await sendSlackMessage(process.env.SLACK_WEBHOOK_NEW_LEADS, embed);
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Typeform webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
