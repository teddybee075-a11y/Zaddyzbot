import {
  enableAutoJoin,
  disableAutoJoin,
  isAutoJoinEnabled,
  enableAutoLinks,
  disableAutoLinks,
  isAutoLinksEnabled,
  extractInviteCode,
  extractInviteCodes,
  queueInviteCodes,
  setAutoJoinAll,
  isAutoJoinAllEnabled
} from './autojoin.js';
import { Telegraf } from 'telegraf';
import {
  generateWAMessageFromContent,
  generateWAMessageContent,
  prepareWAMessageMedia
} from '@whiskeysockets/baileys';

import axios from 'axios';

import {
  connectWhatsApp,
  getSocket,
  getConnectedUserIds,
  logoutWhatsApp,
  loadSavedSessions
} from './whatsapp.js';
import { requireJoined, isOwner, recordUser, getUsers, getMissingChannels } from './membership.js';
import { getPostableGroupIds, countAdminOnlyGroups } from './groups.js';
import { isAdmin, isActualAdmin, getAdmins, addAdmin, removeAdmin } from './premium/admin.js';

import { groupCheckCommand } from './commands/groupcheck.js';
import { mainMenu, commandsMenu } from "./commands/ui.js";
import { ownerCommand } from './commands/owner.js';
import { spamCommand } from './commands/spam.js';
import { betaxxCommand } from './commands/betaxx.js';
import { registerScheduleCommands } from './commands/schedule-flow.js';
import { startScheduleWorker } from './commands/schedule-worker.js';
import { getLinkPreview } from "./commands/link-preview.js";
import { startBroadcastQueue, isBroadcastRunning, getBroadcastStatus } from './commands/broadcast-queue.js';
import { createSchedule, getSchedules, cancelSchedule, getDueSchedules, markScheduleCompleted, markScheduleFailed } from './commands/schedulebroadcast.js';
import { enableGcLinkScan, disableGcLinkScan, isGcLinkScanEnabled } from './commands/gclinkscan.js';
function getRandomStatusBg() {
  const colors = [0xFF00BFA5, 0xFFFB8C00, 0xFF039BE5, 0xFFD81B60, 0xFF5E35B1, 0xFF00897B, 0xFFE91E63, 0xFF43A047, 0xFFAB47BC, 0xFFCE93D8];
  return colors[Math.floor(Math.random()*colors.length)];
}
function getRandomFont() { return Math.floor(Math.random()*6); }

function buildStatusContent(text, previewContent) {
  const bg = getRandomStatusBg();
  const font = getRandomFont();

  // If we have a link preview, MERGE it with color + font
  if (previewContent?.extendedTextMessage) {
    return {
      extendedTextMessage: {
        ...previewContent.extendedTextMessage,
        backgroundArgb: bg,
        font: font
      }
    };
  }
  if (previewContent) {
    // fallback if preview is in other format
    return previewContent;
  }

  // No link → just color + font
  return {
    extendedTextMessage: {
      text: text,
      backgroundArgb: bg,
      font: font
    }
  };
}

const BOT_TOKEN = '8254382496:AAGHr9vOzos2r0cV329EJKKJBkTQriqclqM';

const bot = new Telegraf(BOT_TOKEN);

const pendingBetaxx = new Map();
const betaxxUiMessages = new Map();
const pendingAdminAction = new Map();
const selectedBroadcastSessions = new Map();
const pendingPairing = new Map();
const pendingBlastAll = new Map();
const pendingAnnounce = new Map();
const blastAllRuns = new Map();
const pendingGstatus = new Map();
const pendingExit = new Map();
function getPendingBetaxx(userId) {
  return pendingBetaxx.get(userId);
}

function setPendingBetaxx(userId, data) {
  pendingBetaxx.set(userId, data);
}

function clearPendingBetaxx(userId) {
  pendingBetaxx.delete(userId);
}

bot.action('check_membership', async (ctx) => {
  const missing = await getMissingChannels(ctx);

  if (missing.length === 0) {
    recordUser(ctx.from.id);
    try { await ctx.answerCbQuery('✅ Verified!'); } catch {}
    return ctx.editMessageText('✅ Membership verified! Send your command again to continue.');
  }

  try {
    await ctx.answerCbQuery(
      '❌ Still missing: ' + missing.map(c => '@' + c).join(', '),
      { show_alert: true }
    );
  } catch {}
});

bot.command('menu', async (ctx) => { if (!(await requireJoined(ctx))) return; return mainMenu(ctx); });
bot.command('owner', async (ctx) => { if (!(await requireJoined(ctx))) return; return ownerCommand(ctx); });
bot.command('spam', async (ctx) => { if (!(await requireJoined(ctx))) return; return spamCommand(ctx); });
bot.command('bstatus', async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.reply('🔒 This command is restricted to the bot owner.');
  }
  if (!(await requireJoined(ctx))) return;
  const userId = ctx.from.id;
  const input = ctx.message.text.trim();


  const userSock = getSocket(userId);
  return betaxxCommand(ctx, userSock, setPendingBetaxx);
});

bot.command('bprogress', async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.reply('🔒 This command is restricted to the bot owner.');
  }
  if (!(await requireJoined(ctx))) return;

  const userId = ctx.from.id;
  const status = getBroadcastStatus(userId);

  if (!status) {
    return ctx.reply('No BSTATUS broadcast is currently running.');
  }

  return ctx.reply(
    '📡 BSTATUS STATUS\n\n' +
    'Progress: ' + status.completed + '/' + status.total + ' (' + status.percent + '%)\n' +
    '✅ Sent: ' + status.success + '\n' +
    '❌ Failed: ' + status.failed + '\n' +
    '⏳ Remaining: ' + status.remaining
  );
});

bot.command('blastall', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('🔒 This command is restricted to admins.');
  }
  if (!(await requireJoined(ctx))) return;

  const connectedIds = getConnectedUserIds();

  if (!connectedIds.length) {
    return ctx.reply('No WhatsApp sessions are currently connected.');
  }

  pendingBlastAll.set(ctx.from.id, true);

  return ctx.reply(
    '📡 BLAST ALL\n\n' +
    connectedIds.length + ' connected WhatsApp session' +
    (connectedIds.length === 1 ? '' : 's') + ' found.\n\n' +
    'Send the message you want to post as a group status across ' +
    'every one of them.\n\n' +
    '❌ Use /cancelblastall to cancel.'
  );
});

bot.command('cancelblastall', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.reply('🔒 This command is restricted to admins.');
  }

  pendingBlastAll.delete(ctx.from.id);

  return ctx.reply('Blast all cancelled.');
});

bot.command('announce', async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.reply('🔒 This command is restricted to the bot owner.');
  }

  const users = getUsers();

  if (!users.length) {
    return ctx.reply('No known bot users to announce to yet.');
  }

  pendingAnnounce.set(ctx.from.id, true);

  return ctx.reply(
    '📢 ANNOUNCEMENT\n\n' +
    users.length + ' known bot user' + (users.length === 1 ? '' : 's') + '.\n\n' +
    'Send the message you want everyone using the bot to see.\n\n' +
    '❌ Use /cancelannounce to cancel.'
  );
});

bot.command('cancelannounce', async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.reply('🔒 This command is restricted to the bot owner.');
  }

  pendingAnnounce.delete(ctx.from.id);

  return ctx.reply('Announcement cancelled.');
});

bot.command('confirmbstatus', async (ctx) => {
  const userId = ctx.from.id;
  const input = ctx.message.text.trim();
  const pending = getPendingBetaxx(userId);
  console.log('[BSTATUS DEBUG]', userId, pending ? 'PENDING_' + pending.stage : 'NO_PENDING');

  if (!pending || pending.stage !== 'confirm') {
    return ctx.reply(
      'There is no BSTATUS broadcast ready to send.'
    );
  }

  const selectedBroadcast = selectedBroadcastSessions.get(String(userId));
  const userSock = selectedBroadcast ? getSocket(selectedBroadcast.targetUserId) : getSocket(userId);

  if (!userSock?.user) {
    return ctx.reply(
      'WhatsApp is not connected.'
    );
  }

  if (isBroadcastRunning(userId)) {
    return ctx.reply(
      'A broadcast is already running.'
    );
  }

  const groups = pending.selected;

  if (!groups?.length) {
    return ctx.reply(
      'No groups selected.'
    );
  }

  /*
   * Prepare the preview ONCE.
   */

    let previewContent = null;
  try {
    const waMatch = pending.message.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/i);
    if (waMatch) {
      let waUrl = waMatch[0]; if (!waUrl.startsWith('http')) waUrl = 'https://' + waUrl;
      const code = waMatch[1]; let waTitle='Join WhatsApp Group'; let waDesc='Group chat invite'; let imageMessage;
      try {
        let info=null; try{info=await userSock.groupGetInviteInfo(code);}catch{} if(!info){try{info=await userSock.groupInviteInfo(code);}catch{}} 
        if(info?.subject) waTitle=info.subject; if(info?.desc) waDesc=info.desc.slice(0,100);
        if(info?.id){ try{ let ppUrl=null; try{ppUrl=await userSock.profilePictureUrl(info.id,'image');}catch{} if(!ppUrl){try{ppUrl=await userSock.profilePictureUrl(info.id,'preview');}catch{}} if(ppUrl){({imageMessage}=await prepareWAMessageMedia({image:{url:ppUrl}},{upload:userSock.waUploadToServer,mediaTypeOverride:'thumbnail-link'}));}}catch{} }
        if(!imageMessage){ try{ const waPreview = await getLinkPreview(waUrl, bot.telegram); if(waPreview?.image){ ({imageMessage}=await prepareWAMessageMedia({image:{url:waPreview.image}},{upload:userSock.waUploadToServer,mediaTypeOverride:'thumbnail-link'})); } }catch{} }
      }catch{}
      if(!imageMessage){ try{({imageMessage}=await prepareWAMessageMedia({image:{url:'https://via.placeholder.com/400x400/25D366/FFFFFF?text=WA'}},{upload:userSock.waUploadToServer,mediaTypeOverride:'thumbnail-link'}));}catch{} }
      previewContent = await generateWAMessageContent({ text: pending.message, linkPreview: { 'matched-text': waUrl, title: waTitle, description: waDesc, jpegThumbnail: imageMessage?.jpegThumbnail, highQualityThumbnail: imageMessage, url: waUrl, 'canonical-url': waUrl } }, { getUrlInfo: async () => ({ 'matched-text': waUrl, title: waTitle, description: waDesc, jpegThumbnail: imageMessage?.jpegThumbnail, url: waUrl, 'canonical-url': waUrl }) });
    } else {
      const preview = await getLinkPreview(pending.message, bot.telegram);
      if (preview?.title || preview?.image) { let imageMessage; if (preview.image) { try{({imageMessage}=await prepareWAMessageMedia({image:{url:preview.image}},{upload:userSock.waUploadToServer,mediaTypeOverride:'thumbnail-link'}));}catch{}} previewContent = await generateWAMessageContent({ text: pending.message, linkPreview: { 'matched-text': preview.url, title: preview.title || preview.url, description: preview.description, jpegThumbnail: imageMessage?.jpegThumbnail, highQualityThumbnail: imageMessage } }, { getUrlInfo: async () => ({ 'matched-text': preview.url, title: preview.title || preview.url, description: preview.description, url: preview.url }) }); }
    }
  } catch (error) { console.log('[BSTATUS] Preview unavailable:', error.message); }

  clearPendingBetaxx(userId);
  selectedBroadcastSessions.delete(String(userId));

  const broadcastMessage = await ctx.reply(
    'BSTATUS BROADCAST STARTED\n\n' +
    'Groups: ' + groups.length + '\n' +
    'The broadcast is running in the background.\n\n' +
    'Total: ' + groups.length,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔵 BACK', callback_data: 'ui_commands' }
          ]
        ]
      }
    }
  );

  betaxxUiMessages.set(userId, {
    chatId: ctx.chat.id,
    messageId: broadcastMessage.message_id
  });

  try {
    startBroadcastQueue({
      userId,
      sock: userSock,
      getSock: () =>
        selectedBroadcast
          ? getSocket(selectedBroadcast.targetUserId)
          : getSocket(userId),
      groups,

      createMessage: async (group) => {
        const statusContent = buildStatusContent(pending.message, previewContent);
        return generateWAMessageFromContent(
          group.jid,
          {
            groupStatusMessageV2: {
              message: statusContent
            }
          },
          {}
        );
      },

      onProgress: (state) => {
        if (
          state.completed % 25 === 0 ||
          state.completed === state.total
        ) {
          console.log(
            '[BSTATUS] PROGRESS ' +
            state.completed +
            '/' +
            state.total +
            ' | Sent: ' +
            state.success +
            ' | Failed: ' +
            state.failed
          );
        }

        // Live-update the "broadcast started" message in Telegram itself,
        // so /bprogress isn't the only way to see progress. Throttled
        // to every 10 groups (not the final one — onFinish handles that)
        // to stay well clear of Telegram's edit rate limits.
        if (state.completed < state.total && state.completed % 10 === 0) {
          const uiMessage = betaxxUiMessages.get(userId);

          if (uiMessage) {
            const percent = Math.round((state.completed / state.total) * 100);

            ctx.telegram.editMessageText(
              uiMessage.chatId,
              uiMessage.messageId,
              undefined,
              '📡 BSTATUS BROADCAST RUNNING\n\n' +
              'Progress: ' + state.completed + '/' + state.total + ' (' + percent + '%)\n' +
              '✅ Sent: ' + state.success + '\n' +
              '❌ Failed: ' + state.failed,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: '🔵 BACK', callback_data: 'ui_commands' }]
                  ]
                }
              }
            ).catch(() => {});
          }
        }
      },

      onFinish: async (state) => {
        console.log(
          '[BSTATUS] FINISHED | Sent: ' +
          state.success +
          ' | Failed: ' +
          state.failed +
          ' | Total: ' +
          state.total
        );

        try {
          const uiMessage = betaxxUiMessages.get(userId);

          if (uiMessage) {
            await ctx.telegram.editMessageText(
              uiMessage.chatId,
              uiMessage.messageId,
              undefined,
              'BSTATUS BROADCAST FINISHED\n\n' +
              'Sent: ' + state.success + '\n' +
              'Failed: ' + state.failed + '\n' +
              'Total: ' + state.total,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '🔵 BACK', callback_data: 'ui_commands' }
                    ]
                  ]
                }
              }
            );

            betaxxUiMessages.delete(userId);
          } else {
            await ctx.reply(
              'BSTATUS BROADCAST FINISHED\n\n' +
              'Sent: ' + state.success + '\n' +
              'Failed: ' + state.failed + '\n' +
              'Total: ' + state.total,
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      { text: '🔵 BACK', callback_data: 'ui_commands' }
                    ]
                  ]
                }
              }
            );
          }
        } catch (error) {
          console.error(
            '[BSTATUS] Completion notification failed:',
            error.message
          );
        }
      }
    });
  } catch (error) {
    console.error(
      '[BSTATUS] Queue error:',
      error.message
    );

    betaxxUiMessages.delete(userId);

    return ctx.reply(
      'BSTATUS could not start.\n\n' +
      error.message
    );
  }
});

bot.command('allstatus', async (ctx) => {
  try {
    const userId = ctx.from.id;
  const input = ctx.message.text.trim();
const userSock = getSocket(userId);

if (!userSock?.user) {
  return ctx.reply('❌ WhatsApp is not connected.');
}

const allGroups = await userSock.groupFetchAllParticipating();
    const groupIds = getPostableGroupIds(allGroups);
    const groups = allGroups;
    const skippedCount = countAdminOnlyGroups(allGroups);

    if (!groupIds.length) {
      return ctx.reply(
        skippedCount
          ? `❌ No postable WhatsApp groups found.\n\n(${skippedCount} group${skippedCount === 1 ? '' : 's'} skipped — only admins can message there.)`
          : '❌ No WhatsApp groups found.'
      );
    }

    const selected = groupIds.map((jid, index) => ({
      number: index + 1,
      jid,
      name: groups[jid]?.subject || 'Unnamed group'
    }));

    setPendingBetaxx(ctx.from.id, {
      groupIds,
      groups,
      selected,
      stage: 'message',
      message: ''
    });

    await ctx.reply(
      `🚀 *ALLSTATUS*\n\n` +
      `👥 All ${selected.length} postable WhatsApp groups have been selected.\n\n` +
      (skippedCount
        ? `🔒 ${skippedCount} admin-only group${skippedCount === 1 ? '' : 's'} skipped (members can't message there).\n\n`
        : '') +
      `📝 Now send the message you want to post as group status.\n\n` +
      `❌ Use /cancelbstatus to cancel.`
    );

  } catch (error) {
    console.error('ALLSTATUS ERROR:', error);
    await ctx.reply(
      `❌ Could not load all groups.\n\n${error.message}`
    );
  }
});
// /gstatus
bot.command('gstatus', async (ctx) => {
  if (!isOwner(ctx.from.id)) return ctx.reply('🔒 owner only');
  if (!(await requireJoined(ctx))) return;
  const sock = getSocket(ctx.from.id);
  if (!sock?.user) return ctx.reply('❌ WhatsApp not connected');
  const allGroups = await sock.groupFetchAllParticipating();
  const postableIds = getPostableGroupIds(allGroups);
  const skipped = countAdminOnlyGroups(allGroups);
  if (!postableIds.length) return ctx.reply('No postable groups');
  const selected = postableIds.map((jid,i)=>({ number:i+1, jid, name: allGroups[jid]?.subject||'Unnamed' }));
  pendingGstatus.set(ctx.from.id, { groupIds: postableIds, groups: allGroups, selected, stage:'count', count:1, message:'' });
  let txt = `🚀 *GSTATUS*\n\n👥 All ${selected.length} postable WhatsApp groups have been selected.\n\n🔒 ${skipped} admin-only groups skipped (members can't message there).\n\n🔢 Select count:`;
  return ctx.reply(txt, { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[
    [{text:'1x', callback_data:'gstatus_count_1'}, {text:'5x', callback_data:'gstatus_count_5'}, {text:'10x', callback_data:'gstatus_count_10'}],
    [{text:'20x', callback_data:'gstatus_count_20'}, {text:'50x', callback_data:'gstatus_count_50'}],
    [{text:'❌ Cancel', callback_data:'gstatus_cancel'}]
  ]}});
});
bot.command('cancelgstatus', async (ctx) => { pendingGstatus.delete(ctx.from.id); return ctx.reply('❌ Gstatus cancelled'); });
bot.command('confirmgstatus', async (ctx) => {
  const pending = pendingGstatus.get(ctx.from.id);
  if (!pending || pending.stage!=='confirm') return ctx.reply('No GSTATUS to confirm');
  const sock = getSocket(ctx.from.id);
      let previewContent = null;
  try {
    const waMatch = pending.message.match(/chat\.whatsapp\.com\/([A-Za-z0-9]+)/i);
    if (waMatch) {
      let waUrl = waMatch[0]; if (!waUrl.startsWith('http')) waUrl = 'https://' + waUrl;
      const code = waMatch[1]; let waTitle='Join WhatsApp Group'; let waDesc='Group chat invite'; let imageMessage;
      try {
        let info=null; try{info=await sock.groupGetInviteInfo(code);}catch{} if(!info){try{info=await sock.groupInviteInfo(code);}catch{}} 
        if(info?.subject) waTitle=info.subject; if(info?.desc) waDesc=info.desc.slice(0,100);
        if(info?.id){ try{ let ppUrl=null; try{ppUrl=await sock.profilePictureUrl(info.id,'image');}catch{} if(!ppUrl){try{ppUrl=await sock.profilePictureUrl(info.id,'preview');}catch{}} if(ppUrl){({imageMessage}=await prepareWAMessageMedia({image:{url:ppUrl}},{upload:sock.waUploadToServer,mediaTypeOverride:'thumbnail-link'}));}}catch{} }
        if(!imageMessage){ try{ const waPreview = await getLinkPreview(waUrl, bot.telegram); if(waPreview?.image){ ({imageMessage}=await prepareWAMessageMedia({image:{url:waPreview.image}},{upload:sock.waUploadToServer,mediaTypeOverride:'thumbnail-link'})); } }catch{} }
      }catch{}
      if(!imageMessage){ try{({imageMessage}=await prepareWAMessageMedia({image:{url:'https://via.placeholder.com/400x400/25D366/FFFFFF?text=WA'}},{upload:sock.waUploadToServer,mediaTypeOverride:'thumbnail-link'}));}catch{} }
      previewContent = await generateWAMessageContent({ text: pending.message, linkPreview: { 'matched-text': waUrl, title: waTitle, description: waDesc, jpegThumbnail: imageMessage?.jpegThumbnail, highQualityThumbnail: imageMessage, url: waUrl, 'canonical-url': waUrl } }, { getUrlInfo: async () => ({ 'matched-text': waUrl, title: waTitle, description: waDesc, jpegThumbnail: imageMessage?.jpegThumbnail, url: waUrl, 'canonical-url': waUrl }) });
    } else {
      const preview = await getLinkPreview(pending.message, bot.telegram);
      if (preview?.title || preview?.image) { let imageMessage; if (preview.image) { try{({imageMessage}=await prepareWAMessageMedia({image:{url:preview.image}},{upload:sock.waUploadToServer,mediaTypeOverride:'thumbnail-link'}));}catch{}} previewContent = await generateWAMessageContent({ text: pending.message, linkPreview: { 'matched-text': preview.url, title: preview.title || preview.url, description: preview.description, jpegThumbnail: imageMessage?.jpegThumbnail, highQualityThumbnail: imageMessage } }, { getUrlInfo: async () => ({ 'matched-text': preview.url, title: preview.title || preview.url, description: preview.description, url: preview.url }) }); }
    }
  } catch (error) { console.log('[GSTATUS] Preview unavailable:', error.message); }
  pendingGstatus.delete(ctx.from.id);
  const prog = await ctx.reply(`📡 GSTATUS RUNNING\nGroups: ${pending.selected.length}\nCount: ${pending.count}x\nTotal: ${pending.selected.length*pending.count}`);
  const expanded=[]; for(let i=0;i<pending.count;i++) for(const g of pending.selected) expanded.push(g);
  startBroadcastQueue({
    userId: ctx.from.id, sock, getSock:()=>getSocket(ctx.from.id), groups: expanded,
    createMessage: async (group) => {
      const c = buildStatusContent(pending.message, previewContent);
      return generateWAMessageFromContent(group.jid, { groupStatusMessageV2:{ message:c } }, {});
    },
    onProgress: (s) => { if(s.completed%5===0||s.completed===s.total) ctx.telegram.editMessageText(prog.chat.id, prog.message_id, undefined, `📡 GSTATUS LIVE\n${s.completed}/${s.total} (${Math.round(s.completed/s.total*100)}%) ✅${s.success} ❌${s.failed}`).catch(()=>{}); },
    onFinish: async (s) => { await ctx.telegram.editMessageText(prog.chat.id, prog.message_id, undefined, `✅ GSTATUS FINISHED\nSent: ${s.success}\nFailed: ${s.failed}\nTotal: ${s.total}`).catch(()=>{}); }
  });
});

// /exit
bot.command('exit', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  const sock = getSocket(ctx.from.id);
  if (!sock?.user) return ctx.reply('WhatsApp not connected');
  const allGroups = await sock.groupFetchAllParticipating();
  const ids = Object.keys(allGroups);
  pendingExit.set(ctx.from.id, { allGroups, ids, selected:[] });
  let txt = `🚪 EXIT\nYou are in ${ids.length} groups.\nSend numbers e.g. 1,5,10\n\n` + ids.slice(0,30).map((jid,i)=>`${i+1}. ${allGroups[jid]?.subject||'Unnamed'}`).join('\n');
  return ctx.reply(txt);
});

// /links
bot.command('links', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  const sock = getSocket(ctx.from.id);
  if (!sock?.user) return ctx.reply('WhatsApp not connected');
  await ctx.reply('🔍 Scanning links...');
  const allGroups = await sock.groupFetchAllParticipating();
  let lines=[];
  for(const jid of Object.keys(allGroups)){
    try { const code = await sock.groupInviteCode(jid); if(code) lines.push(`${allGroups[jid]?.subject||jid} - https://chat.whatsapp.com/${code}`); } catch {}
    await new Promise(r=>setTimeout(r,200));
  }
  const content = lines.join('\n');
  await ctx.telegram.sendDocument(ctx.chat.id, { source: Buffer.from(content), filename: `links_${Date.now()}.txt` }, { caption: `🔗 ${lines.length} links from ${Object.keys(allGroups).length} groups` });
});
bot.command('scheduled', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  const schedules = getSchedules(ctx.from.id);
  let text = '📅 YOUR SCHEDULED BROADCASTS\n\n';
  schedules.forEach((schedule, index) => {
    text += (index + 1) + '. ID: ' + schedule.id + '\n' +
      '🕐 ' + new Date(schedule.scheduledAt).toLocaleString() + '\n' +
      '👥 Groups: ' + schedule.groupIds.length + '\n' +
      '📝 ' + schedule.message + '\n\n';
  });
  return ctx.reply(text);
});


bot.on('text', async (ctx, next) => {
  const userId = ctx.from.id;
  const input = ctx.message.text.trim();

  // ==============================
  // BLAST ALL — post to every connected WhatsApp session at once
  // ==============================

  if (pendingBlastAll.has(userId)) {
    pendingBlastAll.delete(userId);

    const messageText = ctx.message.text;
    const connectedIds = getConnectedUserIds();

    if (!connectedIds.length) {
      return ctx.reply('No WhatsApp sessions are connected anymore.');
    }

    // Fetch the link-preview metadata ONCE — it's the same regardless of
    // which WhatsApp account posts it. Each session below only needs to
    // upload the thumbnail image to its own media server, since that
    // part is inherently per-account.
    let previewMeta = null;

    try {
      const preview = await getLinkPreview(messageText, bot.telegram);

      if (preview?.title || preview?.image) {
        previewMeta = preview;
      }
    } catch (error) {
      console.log('[BLASTALL] Preview unavailable:', error.message);
    }

    const progressMessage = await ctx.reply(
      '🚀 BLAST ALL RUNNING\n\n' +
      'Sessions: ' + connectedIds.length + '\n' +
      'Starting broadcast...'
    );

    const summary = [];
    let remaining = connectedIds.length;
    const run = {
      chatId: ctx.chat.id,
      messageId: progressMessage.message_id,
      sessions: new Map(),
      lastEdit: 0,
      editBusy: false,
      editQueued: false
    };
    blastAllRuns.set(String(ctx.from.id), run);

    const renderBlastProgress = () => {
      let total = 0;
      let completed = 0;
      let success = 0;
      let failed = 0;

      for (const state of run.sessions.values()) {
        total += state.total || 0;
        completed += state.completed || 0;
        success += state.success || 0;
        failed += state.failed || 0;
      }

      const percent = total ? Math.round((completed / total) * 100) : 0;
      let text =
        '📡 BLAST ALL PROGRESS\n\n' +
        'Overall: ' + completed + '/' + total + ' (' + percent + '%)\n' +
        '✅ Sent: ' + success + '\n' +
        '❌ Failed: ' + failed + '\n\n';

      for (const [targetUserId, state] of run.sessions) {
        if (state.error) {
          text += 'User ' + targetUserId + ': ❌ ' + state.error + '\n';
        } else {
          const p = state.total ? Math.round((state.completed / state.total) * 100) : 0;
          text +=
            'User ' + targetUserId + ': ' + state.completed + '/' + state.total +
            ' (' + p + '%) — ✅ ' + state.success + ' ❌ ' + state.failed + '\n';
        }
      }

      return text;
    };

    const updateBlastProgress = async (force = false) => {
      const now = Date.now();
      if (!force && now - run.lastEdit < 2000) {
        if (run.editQueued) return;
        run.editQueued = true;
        setTimeout(() => {
          run.editQueued = false;
          updateBlastProgress(true).catch(() => {});
        }, 2000 - (now - run.lastEdit));
        return;
      }

      if (run.editBusy) return;
      run.editBusy = true;
      try {
        await ctx.telegram.editMessageText(
          run.chatId,
          run.messageId,
          undefined,
          renderBlastProgress()
        );
        run.lastEdit = Date.now();
      } catch (error) {
        if (!String(error?.message || '').toLowerCase().includes('message is not modified')) {
          console.log('[BLASTALL] Progress update failed:', error.message);
        }
      } finally {
        run.editBusy = false;
      }
    };

    const finish = async () => {
      let text = '✅ BLAST ALL COMPLETE\n\n';

      for (const s of summary) {
        if (s.error) {
          text += 'User ' + s.userId + ': ❌ ' + s.error + '\n';
        } else {
          text +=
            'User ' + s.userId + ': ' + s.success + '/' + s.total + ' sent' +
            (s.skipped ? ' (' + s.skipped + ' admin-only skipped)' : '') +
            (s.failed ? ' — ' + s.failed + ' failed' : '') +
            '\n';
        }
      }

      try {
        await ctx.telegram.editMessageText(run.chatId, run.messageId, undefined, text);
      } catch {
        ctx.reply(text).catch(() => {});
      }

      blastAllRuns.delete(String(ctx.from.id));
    };

    for (const targetUserId of connectedIds) {
      (async () => {
        try {
          const sock = getSocket(targetUserId);

          if (!sock?.user) {
            run.sessions.set(targetUserId, { error: 'disconnected before it could start', total: 0, completed: 0, success: 0, failed: 0 });
            updateBlastProgress(true).catch(() => {});
            summary.push({ userId: targetUserId, error: 'disconnected before it could start' });
            if (--remaining === 0) finish();
            return;
          }

          if (isBroadcastRunning(targetUserId)) {
            run.sessions.set(targetUserId, { error: 'already has a broadcast in progress, skipped', total: 0, completed: 0, success: 0, failed: 0 });
            updateBlastProgress(true).catch(() => {});
            summary.push({ userId: targetUserId, error: 'already has a broadcast in progress, skipped' });
            if (--remaining === 0) finish();
            return;
          }

          const allGroups = await sock.groupFetchAllParticipating();
          const groupIds = getPostableGroupIds(allGroups);
          const skipped = countAdminOnlyGroups(allGroups);

          run.sessions.set(targetUserId, {
            total: groupIds.length,
            completed: 0,
            success: 0,
            failed: 0
          });
          await updateBlastProgress(true);

          if (!groupIds.length) {
            summary.push({ userId: targetUserId, total: 0, success: 0, failed: 0, skipped });
            if (--remaining === 0) finish();
            return;
          }

          const groups = groupIds.map(jid => ({
            jid,
            name: allGroups[jid]?.subject || 'Unnamed group'
          }));

          // Build this session's own preview content — the media upload
          // has to go through this specific account's own upload server.
          let previewContent = null;

          if (previewMeta) {
            try {
              let imageMessage;

              if (previewMeta.image) {
                try {
                  ({ imageMessage } = await prepareWAMessageMedia(
                    { image: { url: previewMeta.image } },
                    { upload: sock.waUploadToServer, mediaTypeOverride: 'thumbnail-link' }
                  ));
                } catch (imgError) {
                  console.log('[BLASTALL] Preview image upload failed for ' + targetUserId + ':', imgError.message);
                }
              }

              previewContent = await generateWAMessageContent(
                {
                  text: messageText,
                  linkPreview: {
                    'matched-text': previewMeta.url,
                    title: previewMeta.title || previewMeta.url,
                    description: previewMeta.description,
                    jpegThumbnail: imageMessage?.jpegThumbnail,
                    highQualityThumbnail: imageMessage
                  }
                },
                {
                  getUrlInfo: async () => ({
                    'matched-text': previewMeta.url,
                    title: previewMeta.title || previewMeta.url,
                    description: previewMeta.description,
                    jpegThumbnail: imageMessage?.jpegThumbnail,
                    highQualityThumbnail: imageMessage
                  })
                }
              );
            } catch (error) {
              console.log('[BLASTALL] Preview content build failed for ' + targetUserId + ':', error.message);
            }
          }

          startBroadcastQueue({
            userId: targetUserId,
            sock,
            getSock: () => getSocket(targetUserId),
            groups,
            delayMs: 1000,
            concurrency: 1,

            createMessage: async (group) => {
              const statusContent = buildStatusContent(messageText, previewContent);
              return generateWAMessageFromContent(
                group.jid,
                {
                  groupStatusMessageV2: {
                    message: statusContent
                  }
                },
                {}
              );
            },

            onProgress: (state) => {
              run.sessions.set(targetUserId, {
                total: state.total,
                completed: state.completed,
                success: state.success,
                failed: state.failed
              });
              updateBlastProgress().catch(() => {});
            },

            onFinish: (state) => {
              summary.push({
                userId: targetUserId,
                total: state.total,
                success: state.success,
                failed: state.failed,
                skipped
              });
              if (--remaining === 0) finish();
            }
          });

        } catch (error) {
          run.sessions.set(targetUserId, { error: error.message, total: 0, completed: 0, success: 0, failed: 0 });
          updateBlastProgress(true).catch(() => {});
          summary.push({ userId: targetUserId, error: error.message });
          if (--remaining === 0) finish();
        }
      })();
    }

    return;
  }

  // ==============================
  // ANNOUNCE — send a Telegram message to every known bot user
  // ==============================

  if (pendingAnnounce.has(userId)) {
    pendingAnnounce.delete(userId);

    const announcementText = ctx.message.text;
    const users = getUsers();

    await ctx.reply(
      '📢 Sending announcement to ' + users.length + ' user' +
      (users.length === 1 ? '' : 's') + '...'
    );

    let sent = 0;
    let failed = 0;

    for (const targetId of users) {
      try {
        await ctx.telegram.sendMessage(
          targetId,
          '📢 Announcement\n\n' + announcementText
        );
        sent++;
      } catch (error) {
        failed++;
        console.error('Announce failed for ' + targetId + ':', error.message);
      }

      // Light pacing to stay well clear of Telegram's own rate limits on
      // a large user list.
      await new Promise(resolve => setTimeout(resolve, 60));
    }

    return ctx.reply(
      '✅ Announcement sent.\n\n' +
      'Delivered: ' + sent + '\n' +
      'Failed: ' + failed
    );
  }

  // ==============================
  // ADMIN MANAGEMENT INPUT
  // ==============================

  const adminState = pendingAdminAction.get(userId);

  if (adminState) {
    if (!isOwner(userId)) {
      pendingAdminAction.delete(userId);
      return ctx.reply('Owner access required.');
    }

    if (!/^\d+$/.test(input)) {
      return ctx.telegram.editMessageText(
        adminState.chatId,
        adminState.messageId,
        undefined,
        'INVALID TELEGRAM ID\\n\\nSend numbers only.',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔵 BACK', callback_data: 'admin_manage' }
              ]
            ]
          }
        }
      );
    }

    if (input === '6265335081') {
      pendingAdminAction.delete(userId);

      return ctx.telegram.editMessageText(
        adminState.chatId,
        adminState.messageId,
        undefined,
        'OWNER CANNOT BE ADDED OR REMOVED AS AN ADMIN.',
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔵 BACK', callback_data: 'admin_manage' }
              ]
            ]
          }
        }
      );
    }

    if (adminState.action === 'add') {
      addAdmin(input);
      pendingAdminAction.delete(userId);

      return ctx.telegram.editMessageText(
        adminState.chatId,
        adminState.messageId,
        undefined,
        'ADMIN ADDED\\n\\nTelegram ID: ' + input,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔵 BACK', callback_data: 'admin_manage' }
              ]
            ]
          }
        }
      );
    }

    if (adminState.action === 'remove') {
      const removed = removeAdmin(input);
      pendingAdminAction.delete(userId);

      if (!removed) {
        return ctx.telegram.editMessageText(
          adminState.chatId,
          adminState.messageId,
          undefined,
          'ADMIN COULD NOT BE REMOVED.',
          {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🔵 BACK', callback_data: 'admin_manage' }
                ]
              ]
            }
          }
        );
      }

      return ctx.telegram.editMessageText(
        adminState.chatId,
        adminState.messageId,
        undefined,
        'ADMIN REMOVED\\n\\nTelegram ID: ' + input,
        {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🔵 BACK', callback_data: 'admin_manage' }
              ]
            ]
          }
        }
      );
    }

    pendingAdminAction.delete(userId);
  }


  // ==============================
  // WHATSAPP PAIRING
  // ==============================

  if (pendingPairing.has(userId)) {
    const number = ctx.message.text.trim();

    if (!/^[0-9]{10,15}$/.test(number)) {
      return ctx.reply(
        '❌ Invalid number.\n\n' +
        'Example: 2348012345678'
      );
    }

    pendingPairing.delete(userId);

    try {
      await ctx.reply(
        '🔐 Generating your pairing code...'
      );

      const code = await connectWhatsApp(userId, number, (followResult) => {
        const followMessage = followResult?.success
          ? `\n\n✅ Automatically followed the Zaddy channel: ${followResult.channelName}`
          : '\n\n⚠️ WhatsApp connected, but I could not automatically follow the Zaddy channel. Please try opening the channel link manually.';
        ctx.reply(`🎉 *WhatsApp linked successfully!*${followMessage}`, { parse_mode: 'Markdown' }).catch(() => {});
      });

      if (code === 'ALREADY_LINKED') {
        return ctx.reply('✅ Your WhatsApp is already connected.');
      }

      await ctx.reply(
        `🔑 *Your Pairing Code*\n\n` +
        `\`${code}\`\n\n` +
        `📲 *How to link:*\n` +
        `1️⃣ Open WhatsApp\n` +
        `2️⃣ Tap *Linked Devices*\n` +
        `3️⃣ Tap *Link a Device*\n` +
        `4️⃣ Choose *Link with phone number instead*\n` +
        `5️⃣ Enter the code above\n\n` +
        `⏳ Expires in about a minute — enter it quickly!`,
        {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[{ text: '🔵 📋 Copy Code', copy_text: { text: code } }]] }
        }
      );

    } catch (error) {
      console.error(
        `Pairing error for ${userId}:`,
        error
      );

      const looksLikeConnectionIssue =
        /connection closed|timed out|timeout|network/i.test(error.message || '');

      await ctx.reply(
        `❌ I could not generate the pairing code.\n\n` +
        `${error.message}` +
        (looksLikeConnectionIssue
          ? `\n\nThis usually means the connection to WhatsApp's servers ` +
            `couldn't stay open long enough — either a slow/unstable network ` +
            `on this server, or WhatsApp restricting connections from this ` +
            `host's IP address (common on some cloud/VPS providers). ` +
            `Try again in a moment, and if it keeps happening consistently, ` +
            `it may be worth testing from a different host.`
          : '')
      );
    }

    return;
  }

  // ==============================
  // ==============================
  // SCHEDULE BROADCAST HANDLER
  // ==============================

  if (await handleScheduleText(ctx)) {
    return;
  }

  // BSTATUS
  // ==============================
  const gPending = pendingGstatus.get(userId);
  if (gPending && gPending.stage === 'message') {
    gPending.message = input;
    gPending.stage = 'confirm';
    pendingGstatus.set(userId, gPending);
    let preview = '🔊 *Gstatus preview*\n\nMessage:\n' + gPending.message + '\n\nGroups: ' + gPending.selected.length + ' x ' + gPending.count + ' = ' + (gPending.selected.length * gPending.count) + ' posts\n\n' + gPending.selected.slice(0,20).map(g=>g.number+'. '+g.name).join('\n') + '\n\nUse /confirmgstatus & /cancelgstatus';
    return ctx.reply(preview, { parse_mode:'Markdown', reply_markup:{ inline_keyboard:[[{text:'🟢 Confirm', callback_data:'gstatus_confirm_btn'}, {text:'❌ Cancel', callback_data:'gstatus_cancel'}]] } });
  }
  const ePending = pendingExit.get(userId);
  if (ePending) {
    if (!/^\d+(,\d+)*$/.test(input)) return ctx.reply('Send numbers like 1,2,5 or /cancelexit');
    const nums = [...new Set(input.split(',').map(Number))];
    const selected = nums.filter(n=>n>=1 && n<=ePending.ids.length).map(n=>({ jid:ePending.ids[n-1], name:ePending.allGroups[ePending.ids[n-1]]?.subject||'Unnamed' }));
    if (!selected.length) return ctx.reply('Invalid');
    pendingExit.set(userId, { ...ePending, selected });
    return ctx.reply(`🚪 Selected ${selected.length} groups\n`+selected.slice(0,20).map(s=>s.name).join('\n')+`\n\nConfirm?`, { reply_markup:{ inline_keyboard:[[{text:'🟢 Confirm Exit', callback_data:'exit_confirm'}, {text:'❌ Cancel', callback_data:'exit_cancel'}]] } });
  }

  const pending = getPendingBetaxx(userId);

  // STEP 1: SELECT GROUPS
  if (pending && pending.stage === 'groups') {
    if (!/^\d+(,\d+)*$/.test(input)) {
      return ctx.reply(
        'Invalid selection.\n\n' +
        'Use group numbers separated by commas.\n' +
        'Example: 1,7,10'
      );
    }

    const numbers = [...new Set(input.split(',').map(Number))];

    const selected = numbers
      .filter(n => n >= 1 && n <= pending.groupIds.length)
      .map(n => {
        const jid = pending.groupIds[n - 1];

        return {
          number: n,
          jid,
          name: pending.groups[jid]?.subject || 'Unnamed group'
        };
      });

    if (!selected.length) {
      return ctx.reply('None of those group numbers are valid.');
    }

    pending.selected = selected;
    pending.stage = 'message';
    setPendingBetaxx(userId, pending);

    const sample = selected
      .slice(0, 20)
      .map(group => group.number + '. ' + group.name)
      .join('\n');

    let reply =
      'GROUPS SELECTED\n\n' +
      'Total selected: ' + selected.length + '\n\n';

    if (selected.length > 20) {
      reply +=
        'Showing first 20 groups only:\n\n' +
        sample +
        '\n\n...and ' +
        (selected.length - 20) +
        ' more groups.\n\n';
    } else {
      reply += sample + '\n\n';
    }

    reply += 'Now send the message you want BSTATUS to broadcast.';

    return ctx.reply(reply);
  }

  // STEP 2: RECEIVE MESSAGE
  if (pending && pending.stage === 'message') {
    pending.message = input;
    pending.stage = 'confirm';

    setPendingBetaxx(userId, pending);

    const sample = pending.selected
      .slice(0, 20)
      .map(group => group.number + '. ' + group.name)
      .join('\n');

    let preview =
      'BSTATUS PREVIEW\n\n' +
      'Message:\n' +
      pending.message +
      '\n\nGroups: ' +
      pending.selected.length +
      '\n\n';

    if (pending.selected.length > 20) {
      preview +=
        'Showing first 20 groups only:\n\n' +
        sample +
        '\n\n...and ' +
        (pending.selected.length - 20) +
        ' more groups.\n\n';
    } else {
      preview += sample + '\n\n';
    }

    preview +=
      'Use /confirmbstatus to send.\n' +
      'Use /cancelbstatus to cancel.';

    return ctx.reply(preview, { reply_markup: { inline_keyboard: [[{ text: '🟢 CONFIRM BSTATUS', callback_data: 'ui_confirm_betaxx' }], [{ text: '🔴 CANCEL BSTATUS', callback_data: 'ui_cancel_betaxx' }], [{ text: '🔵 BACK', callback_data: 'ui_commands' }]] } });
  }

  return next();
});

bot.action('ui_confirm_betaxx', async (ctx) => {
  await ctx.answerCbQuery();

  return bot.handleUpdate({
    update_id: Date.now(),
    message: {
      message_id: ctx.callbackQuery.message.message_id,
      from: ctx.from,
      chat: ctx.chat,
      date: Math.floor(Date.now() / 1000),
      text: '/confirmbstatus',
      entities: [
        {
          offset: 0,
          length: 13,
          type: 'bot_command'
        }
      ]
    }
  });
});

bot.action('ui_cancel_betaxx', async (ctx) => {
  await ctx.answerCbQuery();

  return bot.handleUpdate({
    update_id: Date.now(),
    message: {
      message_id: ctx.callbackQuery.message.message_id,
      from: ctx.from,
      chat: ctx.chat,
      date: Math.floor(Date.now() / 1000),
      text: '/cancelbstatus',
      entities: [
        {
          offset: 0,
          length: 14,
          type: 'bot_command'
        }
      ]
    }
  });
});

bot.command('cancelbstatus', async (ctx) => {
  const pending = getPendingBetaxx(ctx.from.id);

  if (!pending) {
    return ctx.reply('❌ There is no pending BSTATUS broadcast.');
  }

  clearPendingBetaxx(ctx.from.id);

  await ctx.reply('❌ BSTATUS broadcast cancelled.');
});

bot.command('gclinkscan', async (ctx) => {
  if (!(await requireJoined(ctx))) return;

  const userId = ctx.from.id;
  const userSock = getSocket(userId);

  if (!userSock?.user) {
    return ctx.reply('WhatsApp is not connected.\n\nUse /pair first.');
  }

  if (isGcLinkScanEnabled(userId, 1)) {
    return ctx.reply('GC LINK SCAN is already ON.\n\nA file of collected WhatsApp group links will be sent every 90 minutes.');
  }

  try {
    enableGcLinkScan(userSock, userId, 1, ctx.telegram);
    return ctx.reply(
      'GC LINK SCAN ON\n\n' +
      'I will collect WhatsApp group invite links found through your connected account and send them to you as a .txt file every 90 minutes.'
    );
  } catch (error) {
    console.error('[GCLINKSCAN] Could not start:', error);
    return ctx.reply('Could not start GC LINK SCAN: ' + error.message);
  }
});

bot.command('autojoin', async (ctx) => {
  const callerId = ctx.from.id;
  const arg = ctx.message.text.trim().split(/\s+/)[1]?.toLowerCase();

  if (arg !== 'on' && arg !== 'off') {
    return ctx.reply(
      '🔄 AUTOJOIN\n\nChoose an option:',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🟢 ON', callback_data: 'autojoin_on' },
            { text: '🔴 OFF', callback_data: 'autojoin_off' }
          ]]
        }
      }
    );
  }

  const userSock = getSocket(callerId);
  if (!userSock?.user) {
    return ctx.reply('WhatsApp is not connected.\n\nUse /pair first.');
  }

  if (arg === 'off') {
    const wasEnabled = disableAutoJoin(callerId, 1);
    return ctx.reply(
      'AUTO JOIN\n\nStatus: OFF\n\n' +
      (wasEnabled ? 'Auto-join has been disabled.' : 'Auto-join was already off.')
    );
  }

  if (isAutoJoinEnabled(callerId, 1)) {
    return ctx.reply('AUTO JOIN\n\nStatus: ON\n\nAlready running.');
  }

  const result = enableAutoJoin(userSock, callerId, 1, ctx.telegram);
  return ctx.reply(
    'AUTO JOIN\n\nStatus: ON\n\n' +
    'Joining 1 new WhatsApp group every 5 seconds. After 30 seconds of joining, it pauses for 15 seconds. ' +
    'Groups with 900+ members are prioritized first, then the queue descends through 800+, 700+, ' +
    '600+, 500+, 400+, 300+ and finally 200+. The queue targets about 75% open groups and 25% ' +
    'locked groups, based on available invite metadata.\n\n' +
    'You\'ll get an update every 30 minutes on how many it has joined.'
  );
});

bot.command('autolinks', async (ctx) => {
  if (!(await requireJoined(ctx))) return;

  const userId = ctx.from.id;
  const arg = ctx.message.text.trim().split(/\s+/)[1]?.toLowerCase();

  // /autolinks alone shows the ON/OFF controls.
  if (!arg) {
    return ctx.reply(
      'AUTOLINKS\n\n' +
      'Choose whether to turn the built-in WhatsApp group links ON or OFF.',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🟢 AUTOLINKS ON', callback_data: 'autolinks_on' },
              { text: '🔴 AUTOLINKS OFF', callback_data: 'autolinks_off' }
            ]
          ]
        }
      }
    );
  }

  if (arg !== 'on' && arg !== 'off') {
    return ctx.reply('Use /autolinks, then choose ON or OFF.');
  }

  return handleAutoLinksToggle(ctx, arg === 'on');
});

async function handleAutoLinksToggle(ctx, enable) {
  const userId = ctx.from.id;
  const userSock = getSocket(userId);

  if (!userSock?.user) {
    return ctx.reply('WhatsApp is not connected.\n\nUse /pair first.');
  }

  if (!enable) {
    const wasEnabled = disableAutoLinks(userId, 1);
    return ctx.reply(
      'AUTOLINKS\n\nStatus: OFF\n\n' +
      (wasEnabled ? 'Built-in WhatsApp group link joining has been disabled.' : 'AUTOLINKS was already off.')
    );
  }

  if (isAutoLinksEnabled(userId, 1)) {
    return ctx.reply('AUTOLINKS\n\nStatus: ON\n\nAlready running.');
  }

  try {
    const result = enableAutoLinks(userSock, userId, 1, ctx.telegram);
    return ctx.reply(
      'AUTOLINKS\n\nStatus: ON\n\n' +
      'Joining the built-in WhatsApp group links only.\n' +
      'The normal /autojoin system is separate.\n\n' +
      'Queued built-in links: ' + (result?.builtInCount || 0) + '\n' +
      'Pacing and group-size rules remain the same.'
    );
  } catch (error) {
    console.error(`[AUTOLINKS] Failed for ${userId}:`, error);
    return ctx.reply('Could not start AUTOLINKS: ' + (error?.message || error));
  }
}

bot.action('autolinks_on', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  try { await ctx.answerCbQuery(); } catch {}
  return handleAutoLinksToggle(ctx, true);
});

bot.action('autolinks_off', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  try { await ctx.answerCbQuery(); } catch {}
  return handleAutoLinksToggle(ctx, false);
});

bot.command('autojoinall', async (ctx) => {
  const controllerId = String(ctx.from.id);

  if (!isAdmin(controllerId)) {
    return ctx.reply('🔒 Only the owner or admins can use /autojoinall.');
  }

  setAutoJoinAll(true);

  const users = getUsers()
    .map(String)
    .filter(id => !isOwner(id) && !isActualAdmin(id));

  let enabled = 0;
  let skipped = 0;

  for (const userId of users) {
    const sock = getSocket(userId);
    if (!sock?.user) {
      skipped++;
      continue;
    }

    if (isAutoJoinEnabled(userId, 1)) {
      enabled++;
      continue;
    }

    try {
      enableAutoJoin(sock, userId, 1, ctx.telegram);
      enabled++;
    } catch (error) {
      skipped++;
      console.error(`[AUTOJOIN ALL] Failed for ${userId}:`, error.message);
    }
  }

  return ctx.reply(
    'AUTOJOIN ALL\n\nStatus: ON\n\n' +
    'Autojoin is now enabled for all normal users.\n' +
    'Connected users enabled: ' + enabled +
    (skipped ? '\nUsers not currently connected/skipped: ' + skipped : '') +
    '\n\nNew normal-user sessions will also have Autojoin enabled automatically.'
  );
});


bot.command('autojoinalloff', async (ctx) => {
  const controllerId = String(ctx.from.id);

  if (!isAdmin(controllerId)) {
    return ctx.reply('🔒 Only the owner or admins can use /autojoinalloff.');
  }

  setAutoJoinAll(false);

  const users = getUsers()
    .map(String)
    .filter(id => !isOwner(id) && !isActualAdmin(id));

  let disabled = 0;

  for (const userId of users) {
    if (disableAutoJoin(userId, 1)) {
      disabled++;
    }
  }

  return ctx.reply(
    'AUTOJOIN ALL\n\nStatus: OFF\n\n' +
    'Autojoin has been disabled for all normal users.\n' +
    'Users disabled: ' + disabled +
    '\n\nNew normal-user sessions will no longer have Autojoin enabled automatically.'
  );
});

bot.action('autojoin_on', async (ctx) => {
  await ctx.answerCbQuery();

  return bot.handleUpdate({
    update_id: Date.now(),
    message: {
      message_id: Date.now(),
      from: ctx.from,
      chat: ctx.chat,
      date: Math.floor(Date.now() / 1000),
      text: '/autojoin on',
      entities: [
        {
          offset: 0,
          length: 9,
          type: 'bot_command'
        }
      ]
    }
  });
});

bot.action('autojoin_off', async (ctx) => {
  await ctx.answerCbQuery();

  return bot.handleUpdate({
    update_id: Date.now(),
    message: {
      message_id: Date.now(),
      from: ctx.from,
      chat: ctx.chat,
      date: Math.floor(Date.now() / 1000),
      text: '/autojoin off',
      entities: [
        {
          offset: 0,
          length: 9,
          type: 'bot_command'
        }
      ]
    }
  });
});

bot.command('scan', async (ctx) => {
  if (!(await requireJoined(ctx))) return;

  const userId = ctx.from.id;
  const userSock = getSocket(userId);

  if (!userSock?.user) {
    return ctx.reply(
      'WhatsApp is not connected.\n\n' +
      'Use /pair first.'
    );
  }

  const doc = ctx.message.document || ctx.message.reply_to_message?.document;

  if (!doc) {
    return ctx.reply(
      'SCAN\n\n' +
      'Send a .txt file containing WhatsApp group links, either:\n' +
      '• attached with /scan as the caption, or\n' +
      '• reply to the file with /scan.'
    );
  }

  let fileText;

  try {
    const fileUrl = await ctx.telegram.getFileLink(doc.file_id);
    const response = await axios.get(fileUrl.toString(), { responseType: 'arraybuffer' });
    fileText = Buffer.from(response.data).toString('utf8');
  } catch (error) {
    return ctx.reply('❌ Could not read that file: ' + error.message);
  }

  const codes = extractInviteCodes(fileText);

  if (!codes.length) {
    return ctx.reply('No WhatsApp group links found in that file.');
  }

  const queuedCount = queueInviteCodes(userId, 1, codes);
  const autoJoinOn = isAutoJoinEnabled(userId, 1);

  return ctx.reply(
    'SCAN COMPLETE\n\n' +
    'Found: ' + codes.length + ' link(s)\n' +
    'Queued: ' + queuedCount + ' new link(s)\n\n' +
    (autoJoinOn
      ? 'Autojoin is ON — joining these now in the background.'
      : 'Turn on /autojoin to start joining these groups.')
  );
});

bot.command('join', async (ctx) => {
  if (!(await requireJoined(ctx))) return;

  const userId = ctx.from.id;
  const userSock = getSocket(userId);

  if (!userSock?.user) {
    return ctx.reply(
      'WhatsApp is not connected.\n\n' +
      'Use /pair first.'
    );
  }

  const link = ctx.message.text.trim().split(/\s+/)[1];

  if (!link) {
    return ctx.reply('Usage: /join <whatsapp group invite link>');
  }

  const code = extractInviteCode(link);

  if (!code) {
    return ctx.reply('❌ That doesn\'t look like a valid WhatsApp group invite link.');
  }

  try {
    await userSock.groupAcceptInvite(code);
    return ctx.reply('✅ Joined the group.');
  } catch (error) {
    return ctx.reply('❌ Failed to join: ' + error.message);
  }
});

bot.command('groupcheck', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  const userId = ctx.from.id;
  const userSock = getSocket(userId);
  return groupCheckCommand(ctx, userSock);
});

bot.command('status', async (ctx) => { if (!(await requireJoined(ctx))) return;
  const userId = ctx.from.id;

  const sock = getSocket(userId);

  let text = `📱 *WhatsApp Session*\n\n`;

  if (sock?.user) {
    text += `✅ Connected\n`;
    text += `Account: ${sock.user.id}`;
  } else {
    text += '❌ Not connected.';
  }

  await ctx.reply(text, { parse_mode: 'Markdown' });
});
bot.start(async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  return mainMenu(ctx);
});

bot.action('ui_back', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();
  return mainMenu(ctx);
});

bot.action('ui_commands', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();
  return commandsMenu(ctx);
});

bot.action('ui_autolinks', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  return ctx.editMessageText(
    'AUTOLINKS\n\n' +
    'Choose whether to turn the built-in WhatsApp group links ON or OFF.',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🟢 AUTOLINKS ON', callback_data: 'autolinks_on' },
            { text: '🔴 AUTOLINKS OFF', callback_data: 'autolinks_off' }
          ],
          [
            { text: '🔵 BACK', callback_data: 'ui_commands' }
          ]
        ]
      }
    }
  );
});

bot.action('ui_groups', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  return ctx.editMessageText('GROUPS', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🟢 GROUP CHECK', callback_data: 'ui_groupcheck' }
        ],
        [
          { text: '🔵 BACK', callback_data: 'ui_back' }
        ]
      ]
    }
  });
});

bot.action('ui_settings', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  return ctx.editMessageText('SETTINGS', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🟣 AUTOJOIN', callback_data: 'ui_autojoin' },
          { text: '🟢 STATUS', callback_data: 'ui_status' }
        ],
        [
          { text: '🔴 UNPAIR', callback_data: 'ui_unpair' }
        ],
        [
          { text: '🔵 BACK', callback_data: 'ui_back' }
        ]
      ]
    }
  });
});

bot.action('ui_howto', async (ctx) => {
  if (!(await requireJoined(ctx))) return;

  try {
    await ctx.answerCbQuery();
  } catch {}

  return ctx.editMessageText(
    'HOW TO USE\n\n' +
    '① CONNECT YOUR WHATSAPP\n' +
    'PAIR DEVICE — link your WhatsApp account to the bot.\n' +
    '/unpair — disconnect it. Always unpair before pairing again if something goes wrong.\n' +
    '/status — check if your WhatsApp is connected.\n\n' +
    '② JOIN GROUPS\n' +
    '/join <link> — join one WhatsApp group instantly using its invite link.\n' +
    '/scan — send a .txt file full of group invite links (attach it with /scan as the caption, or reply to it with /scan) to queue them all up.\n' +
    '/autojoin — choose ON or OFF. Turn on, to join WhatsApp groups automatically.\n' +
    '/autolinks — join the built-in WhatsApp group links. Use /autolinks off to stop it.\n' +
    '③ YOUR GROUPS\n' +
    '/groupcheck — see the exact number of groups your paired WhatsApp account is in.\n\n' +
    '④ BROADCASTS\n' +
    'BSTATUS — post a status broadcast to a group you pick.\n' +
    'ALLSTATUS — post the same broadcast to every group you\'re in.\n' +
    '/bprogress — check the live progress of a running broadcast.\n\n' +
    '⑤ SCHEDULING\n' +
    'SCHEDULE BROADCAST — set up a broadcast to repeat automatically.\n' +
    '/scheduled — see your upcoming scheduled broadcasts.\n' +
    'CANCEL SCHEDULE — stop one.\n\n' +
    '⑥ ADMIN & OWNER TOOLS\n' +
    '/blastall — (admin) post one message across every connected WhatsApp session at once.\n' +
    '/announce — (owner) send a message to every Telegram user who uses this bot.\n\n' +
    'Need to join our channels first? Use /start and follow the prompts.',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔵 BACK', callback_data: 'ui_back' }
          ]
        ]
      }
    }
  );
});

bot.action('ui_broadcast_help', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  return ctx.editMessageText('BROADCASTS', {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🔵 BSTATUS', callback_data: 'ui_betaxx' },
          { text: '🔴 ALLSTATUS', callback_data: 'ui_allbetaxx' }
        ],
        [
          { text: '🔵 BACK', callback_data: 'ui_howto' }
        ]
      ]
    }
  });
});

bot.action('ui_schedule_help', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  return ctx.editMessageText('SCHEDULES', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🟠 SCHEDULE BROADCAST', callback_data: 'ui_schedule' }],
        [
          { text: '🟠 SCHEDULED', callback_data: 'ui_scheduled' },
          { text: '🔴 CANCEL SCHEDULE', callback_data: 'ui_cancel_schedule' }
        ],
        [
          { text: '🔵 BACK', callback_data: 'ui_howto' }
        ]
      ]
    }
  });
});

bot.action('ui_pair', async (ctx) => {
  return bot.handleUpdate({
    update_id: Date.now(),
    message: {
      message_id: Date.now(),
      from: ctx.from,
      chat: ctx.chat,
      date: Math.floor(Date.now() / 1000),
      text: '/pair',
      entities: [
        {
          offset: 0,
          length: 5,
          type: 'bot_command'
        }
      ]
    }
  });
});

bot.action('ui_blastall', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.answerCbQuery('Admin access required.', { show_alert: true });
  }

  try { await ctx.answerCbQuery(); } catch {}

  return bot.handleUpdate({
    update_id: Date.now(),
    message: {
      message_id: Date.now(),
      from: ctx.from,
      chat: ctx.chat,
      date: Math.floor(Date.now() / 1000),
      text: '/blastall',
      entities: [
        {
          offset: 0,
          length: 9,
          type: 'bot_command'
        }
      ]
    }
  });
});

bot.action('ui_unpair', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  const userId = ctx.from.id;

  try {
    const sock = getSocket(userId);

    if (!sock) {
      return ctx.editMessageText('NO ACTIVE WHATSAPP SESSION', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔵 BACK', callback_data: 'ui_settings' }]
          ]
        }
      });
    }

    await logoutWhatsApp(userId);

    return ctx.editMessageText('WHATSAPP SESSION UNPAIRED', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔵 PAIR DEVICE', callback_data: 'ui_pair' }],
          [{ text: '🔵 BACK', callback_data: 'ui_settings' }]
        ]
      }
    });
  } catch (error) {
    console.error('UI UNPAIR ERROR:', error);

    return ctx.editMessageText('COULD NOT UNPAIR SESSION', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔵 BACK', callback_data: 'ui_settings' }]
        ]
      }
    });
  }
});

bot.action('ui_status', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  const sock = getSocket(userId);

  const text = sock?.user
    ? 'WHATSAPP SESSION\n\nStatus: ✅ CONNECTED\nAccount: ' + sock.user.id
    : 'WHATSAPP SESSION\n\nStatus: ❌ NOT CONNECTED';

  return ctx.editMessageText(text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔵 BACK', callback_data: 'ui_settings' }]
      ]
    }
  });
});

bot.action('ui_gclinkscan', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  try { await ctx.answerCbQuery(); } catch {}

  const userId = ctx.from.id;
  const userSock = getSocket(userId);

  if (!userSock?.user) {
    return ctx.reply('WhatsApp is not connected.\n\nUse /pair first.');
  }

  if (isGcLinkScanEnabled(userId, 1)) {
    return ctx.reply('GC LINK SCAN is already ON.\n\nA file of collected WhatsApp group links will be sent every 90 minutes.');
  }

  try {
    enableGcLinkScan(userSock, userId, 1, ctx.telegram);
    return ctx.reply(
      'GC LINK SCAN ON\n\n' +
      'I will collect WhatsApp group invite links found through your connected account and send them to you as a .txt file every 90 minutes.'
    );
  } catch (error) {
    console.error('[GCLINKSCAN] Could not start:', error);
    return ctx.reply('Could not start GC LINK SCAN: ' + error.message);
  }
});

bot.action('ui_autojoin', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  const userId = ctx.from.id;
  const userSock = getSocket(userId);

  if (!userSock?.user) {
    return ctx.editMessageText('WHATSAPP IS NOT CONNECTED', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔵 PAIR DEVICE', callback_data: 'ui_pair' }],
          [{ text: '🔵 BACK', callback_data: 'ui_settings' }]
        ]
      }
    });
  }

  const enabled = isAutoJoinEnabled(userId, 1);

  if (enabled) {
    disableAutoJoin(userId, 1);
  } else {
    enableAutoJoin(userSock, userId, 1, ctx.telegram);
  }

  return ctx.editMessageText(
    'AUTOJOIN\n\nSTATUS: ' + (enabled ? 'OFF' : 'ON'),
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🟣 AUTOJOIN', callback_data: 'ui_autojoin' }],
          [{ text: '🔵 BACK', callback_data: 'ui_settings' }]
        ]
      }
    }
  );
});


bot.action('ui_groupcheck', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  const userSock = getSocket(ctx.from.id);

  if (!userSock?.user) {
    return ctx.editMessageText('WHATSAPP IS NOT CONNECTED', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔵 PAIR DEVICE', callback_data: 'ui_pair' }],
          [{ text: '🔵 BACK', callback_data: 'ui_groups' }]
        ]
      }
    });
  }

  try {
    const groups = await userSock.groupFetchAllParticipating();
    const count = Object.keys(groups).length;

    return ctx.editMessageText('GROUP CHECK\n\n' + count + ' GROUP' + (count === 1 ? '' : 'S'), {

      reply_markup: {
        inline_keyboard: [
          [{ text: '🔵 BACK', callback_data: 'ui_groups' }]
        ]
      }
    });
  } catch (error) {
    return ctx.editMessageText('COULD NOT COUNT GROUPS', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔵 BACK', callback_data: 'ui_groups' }]
        ]
      }
    });
  }
});

bot.action('ui_betaxx', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  if (!isOwner(ctx.from.id)) {
    return ctx.editMessageText('🔒 BSTATUS is restricted to the bot owner.', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔵 BACK', callback_data: 'ui_commands' }]
        ]
      }
    });
  }

  return ctx.editMessageText('BSTATUS', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🟢 START BSTATUS', callback_data: 'ui_start_betaxx' }],
        [{ text: '🔵 BACK', callback_data: 'ui_commands' }]
      ]
    }
  });
});

bot.action('ui_allbetaxx', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  return ctx.editMessageText('ALLSTATUS', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔴 START ALLSTATUS', callback_data: 'ui_start_allbetaxx' }],
        [{ text: '🔵 BACK', callback_data: 'ui_commands' }]
      ]
    }
  });
});

bot.action(/^gstatus_count_(\d+)$/, async (ctx) => {
  const p = pendingGstatus.get(ctx.from.id);
  if (!p) return ctx.answerCbQuery('No pending');
  p.count = parseInt(ctx.match[1]); p.stage='message'; pendingGstatus.set(ctx.from.id,p);
  await ctx.answerCbQuery(p.count+'x');
  return ctx.editMessageText(`✅ Count: ${p.count}x\n\n📝 Now send the message you want to post as group status.\n\n❌ Use /cancelgstatus to cancel.`);
});

bot.action('gstatus_confirm_btn', async (ctx) => {
  await ctx.answerCbQuery();
  return bot.handleUpdate({ update_id: Date.now(), message:{ message_id: Date.now(), from: ctx.from, chat: ctx.chat, date: Math.floor(Date.now()/1000), text:'/confirmgstatus', entities:[{offset:0,length:15,type:'bot_command'}] } });
});

bot.action('gstatus_cancel', async (ctx) => { pendingGstatus.delete(ctx.from.id); await ctx.answerCbQuery(); return ctx.editMessageText('❌ Gstatus cancelled'); });

bot.action('exit_confirm', async (ctx) => {
  const data = pendingExit.get(ctx.from.id);
  if (!data?.selected?.length) return ctx.answerCbQuery('No selection');
  await ctx.answerCbQuery('Exiting...');
  const sock = getSocket(ctx.from.id);
  let ok=0,fail=0;
  for(const g of data.selected){ try{ await sock.groupLeave(g.jid); ok++; }catch{fail++;} await new Promise(r=>setTimeout(r,800)); }
  pendingExit.delete(ctx.from.id);
  return ctx.editMessageText(`✅ EXIT DONE\nExited: ${ok}\nFailed: ${fail}`);
});

bot.action('exit_cancel', async (ctx) => { pendingExit.delete(ctx.from.id); await ctx.answerCbQuery(); return ctx.editMessageText('❌ Exit cancelled'); });

bot.action('ui_schedule', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  return ctx.editMessageText(
    'SCHEDULE BROADCAST\\n\\n' +
    'Send the command with your interval.\\n\\n' +
    'Example: /schedulebroadcast 30 mins',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔵 BACK', callback_data: 'ui_commands' }]
        ]
      }
    }
  );
});

bot.action('ui_scheduled', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  const schedules = getSchedules(ctx.from.id);

  if (!schedules.length) {
    return ctx.editMessageText('NO ACTIVE RECURRING BROADCASTS', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔵 BACK', callback_data: 'ui_commands' }]
        ]
      }
    });
  }

  const rows = schedules.map((schedule, index) => [
    {
      text: 'SCHEDULE ' + (index + 1) + ' — ' + schedule.id,
      callback_data: 'ui_schedule_item_' + index
    }
  ]);

  rows.push([{ text: '🔵 BACK', callback_data: 'ui_commands' }]);

  return ctx.editMessageText('YOUR SCHEDULED BROADCASTS', {
    reply_markup: {
      inline_keyboard: rows
    }
  });
});

bot.action('ui_cancel_schedule', async (ctx) => {
  if (!(await requireJoined(ctx))) return;
  await ctx.answerCbQuery();

  return ctx.editMessageText('CANCEL SCHEDULE', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🟠 ENTER SCHEDULE ID', callback_data: 'ui_cancel_id' }],
        [{ text: '🔵 BACK', callback_data: 'ui_commands' }]
      ]
    }
  });
});

bot.action('ui_cancel_id', async (ctx) => {
  await ctx.answerCbQuery();

  return ctx.editMessageText(
    'Send the schedule ID you want to cancel.',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔵 BACK', callback_data: 'ui_commands' }]
        ]
      }
    }
  );
});


bot.action('admin_autojoin_all_on', async (ctx) => {
  const controllerId = String(ctx.from.id);

  if (!isAdmin(controllerId)) {
    return ctx.answerCbQuery('Admin access required.', { show_alert: true });
  }

  try { await ctx.answerCbQuery(); } catch {}

  setAutoJoinAll(true);

  const users = getUsers()
    .map(String)
    .filter(id => !isOwner(id) && !isActualAdmin(id));

  let enabled = 0;
  let skipped = 0;

  for (const userId of users) {
    const sock = getSocket(userId);

    if (!sock?.user) {
      skipped++;
      continue;
    }

    if (isAutoJoinEnabled(userId, 1)) {
      enabled++;
      continue;
    }

    try {
      enableAutoJoin(sock, userId, 1, ctx.telegram);
      enabled++;
    } catch (error) {
      skipped++;
      console.error(`[AUTOJOIN ALL] Failed for ${userId}:`, error.message);
    }
  }

  return ctx.editMessageText(
    'AUTOJOIN ALL\n\nStatus: ON\n\n' +
    'Autojoin is now enabled for all normal users.\n' +
    'Connected users enabled: ' + enabled +
    (skipped ? '\nUsers not currently connected/skipped: ' + skipped : '') +
    '\n\nNew normal-user sessions will also have Autojoin enabled automatically.',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔴 AUTOJOIN ALL OFF', callback_data: 'admin_autojoin_all_off' }
          ],
          [
            { text: '🔵 BACK', callback_data: 'admin_owner_back' }
          ]
        ]
      }
    }
  );
});

bot.action('admin_autojoin_all_off', async (ctx) => {
  const controllerId = String(ctx.from.id);

  if (!isAdmin(controllerId)) {
    return ctx.answerCbQuery('Admin access required.', { show_alert: true });
  }

  try { await ctx.answerCbQuery(); } catch {}

  setAutoJoinAll(false);

  const users = getUsers()
    .map(String)
    .filter(id => !isOwner(id) && !isActualAdmin(id));

  let disabled = 0;

  for (const userId of users) {
    if (disableAutoJoin(userId, 1)) {
      disabled++;
    }
  }

  return ctx.editMessageText(
    'AUTOJOIN ALL\n\nStatus: OFF\n\n' +
    'Autojoin has been disabled for all normal users.\n' +
    'Users disabled: ' + disabled +
    '\n\nNew normal-user sessions will no longer have Autojoin enabled automatically.',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🟢 AUTOJOIN ALL ON', callback_data: 'admin_autojoin_all_on' }
          ],
          [
            { text: '🔵 BACK', callback_data: 'admin_owner_back' }
          ]
        ]
      }
    }
  );
});

bot.action('admin_manage', async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.answerCbQuery('Owner only.', { show_alert: true });
  }

  try { await ctx.answerCbQuery(); } catch {}

  return ctx.editMessageText(
    'ADMIN MANAGEMENT',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🟢 ADD ADMIN', callback_data: 'admin_add' },
            { text: '🔴 REMOVE ADMIN', callback_data: 'admin_remove' }
          ],
          [
            { text: '🟣 LIST ADMINS', callback_data: 'admin_list' }
          ],
          [
            { text: '🔵 BACK', callback_data: 'admin_owner_back' }
          ]
        ]
      }
    }
  );
});

bot.action('admin_add', async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.answerCbQuery('Owner only.', { show_alert: true });
  }

  try { await ctx.answerCbQuery(); } catch {}

  pendingAdminAction.set(ctx.from.id, { action: 'add', chatId: ctx.chat.id, messageId: ctx.callbackQuery.message.message_id });

  return ctx.editMessageText(
    'ADD ADMIN\n\n' +
    'Send the Telegram ID of the user you want to make an admin.\n\n' +
    'Example:\n' +
    '123456789',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔵 BACK', callback_data: 'admin_manage' }
          ]
        ]
      }
    }
  );
});

bot.action('admin_remove', async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.answerCbQuery('Owner only.', { show_alert: true });
  }

  try { await ctx.answerCbQuery(); } catch {}

  pendingAdminAction.set(ctx.from.id, { action: 'remove', chatId: ctx.chat.id, messageId: ctx.callbackQuery.message.message_id });

  return ctx.editMessageText(
    'REMOVE ADMIN\n\n' +
    'Send the Telegram ID of the admin you want to remove.\n\n' +
    'Example:\n' +
    '123456789',
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔵 BACK', callback_data: 'admin_manage' }
          ]
        ]
      }
    }
  );
});

bot.action('admin_list', async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.answerCbQuery('Owner only.', { show_alert: true });
  }

  try { await ctx.answerCbQuery(); } catch {}

  const admins = getAdmins();

  const text = admins.length
    ? 'ADMIN LIST\n\n' +
      admins.map((id, i) => (i + 1) + '. ' + id).join('\n')
    : 'ADMIN LIST\n\nNo admins have been added.';

  return ctx.editMessageText(
    text,
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔵 BACK', callback_data: 'admin_manage' }
          ]
        ]
      }
    }
  );
});

bot.action('admin_owner_back', async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    return ctx.answerCbQuery('Owner only.', { show_alert: true });
  }

  try { await ctx.answerCbQuery(); } catch {}

  return ownerCommand(ctx);
});


bot.action('admin_broadcast', async (ctx) => {
  console.log('[BROADCAST CONTROL] callback received from', ctx.from.id);
  const controllerId = String(ctx.from.id);
  if (!isAdmin(controllerId)) {
    return ctx.answerCbQuery('Admin access required.', { show_alert: true });
  }
  try { await ctx.answerCbQuery(); } catch {}
  const owner = isOwner(controllerId);
  const users = getUsers().map(String).filter(id => owner || (!isOwner(id) && !isActualAdmin(id)));
  const keyboard = users.map(id => [{ text: 'USER ' + id, callback_data: 'admin_broadcast_user_' + id }]);
  keyboard.push([{ text: '🔵 BACK', callback_data: 'admin_owner_back' }]);
  return ctx.editMessageText('BROADCAST CONTROL\n\nSelect a user:', { reply_markup: { inline_keyboard: keyboard } });
});

bot.action(/^admin_broadcast_user_(\d+)$/, async (ctx) => {
  const controllerId = String(ctx.from.id);
  const targetUserId = String(ctx.match[1]);
  if (!isAdmin(controllerId)) return ctx.answerCbQuery('Admin access required.', { show_alert: true });
  if (!isOwner(controllerId) && (isOwner(targetUserId) || isActualAdmin(targetUserId))) return ctx.answerCbQuery('You cannot control this user.', { show_alert: true });
  const sock = getSocket(targetUserId);
  if (!sock || !sock.user) return ctx.answerCbQuery('WhatsApp session is not connected.', { show_alert: true });
  selectedBroadcastSessions.set(controllerId, { targetUserId });
  try { await ctx.answerCbQuery(); } catch {}
  return ctx.editMessageText('BROADCAST CONTROL\n\nTelegram ID: ' + targetUserId + '\n\nSELECT ACTION', { reply_markup: { inline_keyboard: [ [{ text: '🔵 BSTATUS', callback_data: 'admin_broadcast_betaxx' }], [{ text: '🔴 ALLSTATUS', callback_data: 'admin_broadcast_allbetaxx' }], [{ text: '🟠 SCHEDULE BROADCAST', callback_data: 'admin_broadcast_schedule' }], [{ text: '🔵 BACK', callback_data: 'admin_broadcast' }] ] } });
});

bot.action('admin_broadcast_betaxx', async (ctx) => {
  const controllerId = String(ctx.from.id);
  if (!isAdmin(controllerId)) return ctx.answerCbQuery('Admin access required.', { show_alert: true });
  const selected = selectedBroadcastSessions.get(controllerId);
  if (!selected) return ctx.answerCbQuery('No broadcast session selected.', { show_alert: true });
  const sock = getSocket(selected.targetUserId);
  if (!sock || !sock.user) return ctx.answerCbQuery('WhatsApp session is not connected.', { show_alert: true });
  try { await ctx.answerCbQuery(); } catch {}
  return betaxxCommand(ctx, sock, setPendingBetaxx);
});

bot.action('admin_broadcast_allbetaxx', async (ctx) => {
  const controllerId = String(ctx.from.id);
  if (!isAdmin(controllerId)) return ctx.answerCbQuery('Admin access required.', { show_alert: true });
  const selected = selectedBroadcastSessions.get(controllerId);
  if (!selected) return ctx.answerCbQuery('No broadcast session selected.', { show_alert: true });
  const sock = getSocket(selected.targetUserId);
  if (!sock || !sock.user) return ctx.answerCbQuery('WhatsApp session is not connected.', { show_alert: true });
  try { await ctx.answerCbQuery(); } catch {}
  const allGroups = await sock.groupFetchAllParticipating();
  const groupIds = getPostableGroupIds(allGroups);
  const groups = allGroups;
  const skippedCount = countAdminOnlyGroups(allGroups);
  if (!groupIds.length) return ctx.editMessageText(skippedCount ? `No postable WhatsApp groups found.\n\n(${skippedCount} skipped — admin-only.)` : 'No WhatsApp groups found.');
  const selectedGroups = groupIds.map((jid, index) => ({ number: index + 1, jid, name: groups[jid]?.subject || 'Unnamed group' }));
  setPendingBetaxx(Number(controllerId), { groupIds, groups, selected: selectedGroups, stage: 'message', message: '' });
  return ctx.reply('ALLSTATUS\n\nAll ' + selectedGroups.length + ' postable WhatsApp groups have been selected.' + (skippedCount ? '\n\n' + skippedCount + ' admin-only group' + (skippedCount === 1 ? '' : 's') + ' skipped.' : '') + '\n\nSend the message you want to post as group status.\n\nUse /cancelbstatus to cancel.');
});

bot.action('admin_users', async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.answerCbQuery('Admin access required.', { show_alert: true });
  }

  try { await ctx.answerCbQuery(); } catch {}

  const owner = isOwner(ctx.from.id);
  const knownUsers = getUsers()
    .map(String)
    .filter(id => owner || (!isOwner(id) && !isActualAdmin(id)));

  if (!knownUsers.length) {
    return ctx.editMessageText(
      'USER SESSIONS\\n\\nNo users are available.',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔵 BACK', callback_data: 'admin_owner_back' }
            ]
          ]
        }
      }
    );
  }

  const keyboard = [];

  for (const userId of knownUsers) {
    keyboard.push([
      {
        text: 'USER ' + userId,
        callback_data: 'admin_session_user_' + userId
      }
    ]);
  }

  keyboard.push([
    { text: '🔵 BACK', callback_data: 'admin_owner_back' }
  ]);

  return ctx.editMessageText(
    'USER SESSIONS\\n\\nSelect a user:',
    {
      reply_markup: {
        inline_keyboard: keyboard
      }
    }
  );
});

bot.action(/^admin_session_user_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.answerCbQuery('Admin access required.', { show_alert: true });
  }

  const targetUserId = String(ctx.match[1]);
  const controllerId = String(ctx.from.id);

  if (
    !isOwner(controllerId) &&
    (isOwner(targetUserId) || isActualAdmin(targetUserId))
  ) {
    return ctx.answerCbQuery(
      'You cannot control this user.',
      { show_alert: true }
    );
  }

  try { await ctx.answerCbQuery(); } catch {}

  const sock = getSocket(targetUserId);

  const keyboard = [
    [
      {
        text: '🟢 REFRESH',
        callback_data:
          'admin_session_user_' + targetUserId
      }
    ],
    [
      {
        text: '🟣 LOGOUT SESSION',
        callback_data:
          'admin_session_logout_' + targetUserId
      }
    ],
    [
      { text: '🔵 BACK', callback_data: 'admin_users' }
    ]
  ];

  return ctx.editMessageText(
    'SESSION CONTROL\n\n' +
    'Telegram ID: ' + targetUserId + '\n' +
    'Status: ' + (sock?.user ? 'CONNECTED' : 'OFFLINE'),
    {
      reply_markup: {
        inline_keyboard: keyboard
      }
    }
  );
});

bot.action(/^admin_session_broadcast_(\d+)$/, async (ctx) => {
  const controllerId = String(ctx.from.id);
  const targetUserId = String(ctx.match[1]);
  if (!isAdmin(controllerId)) return ctx.answerCbQuery('Admin access required.', { show_alert: true });
  if (!isOwner(controllerId) && (isOwner(targetUserId) || isActualAdmin(targetUserId))) return ctx.answerCbQuery('You cannot control this user.', { show_alert: true });
  const sock = getSocket(targetUserId);
  if (!sock || !sock.user) return ctx.answerCbQuery('WhatsApp session is not connected.', { show_alert: true });
  selectedBroadcastSessions.set(controllerId, { targetUserId });
  try { await ctx.answerCbQuery(); } catch {}
  return betaxxCommand(ctx, sock, setPendingBetaxx);
});

bot.action(/^admin_session_logout_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) {
    return ctx.answerCbQuery('Admin access required.', { show_alert: true });
  }

  const targetUserId = String(ctx.match[1]);
  const controllerId = String(ctx.from.id);

  if (
    !isOwner(controllerId) &&
    (isOwner(targetUserId) || isActualAdmin(targetUserId))
  ) {
    return ctx.answerCbQuery(
      'You cannot control this user.',
      { show_alert: true }
    );
  }

  try { await ctx.answerCbQuery(); } catch {}

  await logoutWhatsApp(targetUserId);

  return ctx.editMessageText(
    'SESSION LOGGED OUT\n\n' +
    'Telegram ID: ' + targetUserId,
    {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '🟠 BACK TO SESSION',
              callback_data:
                'admin_session_user_' + targetUserId
            }
          ],
          [
            {
              text: '🔴 BACK TO USERS',
              callback_data: 'admin_users'
            }
          ]
        ]
      }
    }
  );
});

bot.action('ui_start_betaxx', async (ctx) => {
  return bot.handleUpdate({
    update_id: Date.now(),
    message: {
      message_id: Date.now(),
      from: ctx.from,
      chat: ctx.chat,
      date: Math.floor(Date.now() / 1000),
      text: '/bstatus',
      entities: [
        {
          offset: 0,
          length: 7,
          type: 'bot_command'
        }
      ]
    }
  });
});

bot.action('ui_start_allbetaxx', async (ctx) => {
  return bot.handleUpdate({
    update_id: Date.now(),
    message: {
      message_id: Date.now(),
      from: ctx.from,
      chat: ctx.chat,
      date: Math.floor(Date.now() / 1000),
      text: '/allstatus',
      entities: [
        {
          offset: 0,
          length: 10,
          type: 'bot_command'
        }
      ]
    }
  });
});

bot.command('unpair', async (ctx) => {
  const userId = ctx.from.id;

  try {
    const sock = getSocket(userId);

    if (!sock) {
      return ctx.reply('No active WhatsApp session found.');
    }

    await logoutWhatsApp(userId);

    return ctx.reply(
      'WhatsApp session unpaired successfully.\n\n' +
      'Your session has been cleared. You can use /pair again whenever you want.'
    );
  } catch (error) {
    console.error('UNPAIR ERROR:', error);

    return ctx.reply(
      'Could not unpair the WhatsApp session.\n\n' +
      error.message
    );
  }
});
bot.command('pair', async (ctx) => {
  const userId = ctx.from.id;

  try {
    const existing = getSocket(userId);

    if (existing?.user) {
      return ctx.reply(
        '✅ Your WhatsApp is already connected.'
      );
    }

    await ctx.reply(
      '📱 Send your WhatsApp number with country code.\n\n' +
      'Example:\n' +
      '2348012345678\n\n' +
      '❌ No + sign\n' +
      '❌ No spaces\n' +
      '❌ No dashes'
    );

    pendingPairing.set(userId, true);

  } catch (error) {
    console.error('PAIR COMMAND ERROR:', error);

    await ctx.reply(
      `❌ Could not start pairing.\n\n${error.message}`
    );
  }
});

await loadSavedSessions();

startScheduleWorker({
  getDueSchedules,
  getUserSock: getSocket,
  markScheduleCompleted,
  markScheduleFailed,
  telegramApi: bot.telegram
});

const handleScheduleText = registerScheduleCommands(bot, {
  requireJoined,
  getUserSock: getSocket,
  createSchedule,
  getSchedules,
  cancelSchedule
});

await bot.launch();

console.log('🤖 Telegram bot is running...');
