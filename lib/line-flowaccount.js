import { createExpenseStore } from './expense-store.js';
import { createFlowOAuth } from './flowaccount-oauth.js';
import { createMcpClient } from './flowaccount-mcp.js';

const csv = value => String(value || '').split(',').map(s => s.trim()).filter(Boolean);
export function createLineFlowAccount({ replyText, env = process.env, oauth = createFlowOAuth({ redis: createExpenseStore({ env }), env }), createClient = createMcpClient }) {
  return async event => {
    if (env.MCP_CONNECTIONS_ENABLED !== 'true' || event.type !== 'message' || event.message?.type !== 'text') return false;
    const command = event.message.text.trim().toLowerCase();
    if (!['flow connect', 'flow status', 'חבר flowaccount', 'מצב flowaccount'].includes(command)) return false;
    const actor = { groupId: event.source?.groupId, userId: event.source?.userId };
    if (!csv(env.EXPENSE_GROUP_IDS).includes(actor.groupId) || !csv(env.EXPENSE_USER_IDS).includes(actor.userId)) return true;
    try {
      if (command === 'flow connect' || command === 'חבר flowaccount') {
        await replyText(event.replyToken, `להתחברות ל־FlowAccount בחר את חברת ההוצאות ואשר גישה:\n${await oauth.start(actor)}\nהקישור אישי ותקף לעשר דקות. החיבור אינו מאשר הוצאות או תשלומים.`);
      } else {
        const status = await oauth.status(actor);
        if (!status.connected) await replyText(event.replyToken, 'FlowAccount עדיין לא מחובר לבוט. כתוב flow connect להתחברות.');
        else {
          const client = await createClient({ getToken: () => oauth.getToken(actor) })();
          const context = await client.call('company_settings__load');
          if (String(context.user?.current_company_id) !== env.FLOWACCOUNT_COMPANY_ID) throw new Error('Company mismatch');
          await replyText(event.replyToken, `FlowAccount מחובר: ${context.company?.company_name_foreign || context.company?.company_name_local || 'חברת ההוצאות'}.\nקריאה ותצוגה מקדימה זמינות. רישום הוצאות אוטומטי וצירוף תמונות עדיין אינם מופעלים.`);
        }
      }
    } catch {
      // Never send exception bodies, tokens, authorization codes or provider data to LINE.
      await replyText(event.replyToken, 'חיבור FlowAccount לא הושלם. בדוק את הגדרות הבוט או התחבר מחדש באמצעות flow connect.');
    }
    return true;
  };
}
