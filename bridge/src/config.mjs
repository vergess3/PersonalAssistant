export const target={slackTeam:'T0CELHT6ZGV',slackUser:'U0CEPTK5MRC',slackChannel:'D0CEB1J8G07',slackAssistantUser:'U0CES78F8P4'};
export function configFrom(s) {
  return {...target,weixinUserId:s.weixin?.userId,weixinBotId:s.weixin?.botId,
    weixinOrigin:s.weixin?.origin||'https://ilinkai.weixin.qq.com',channelVersion:s.weixin?.version||''};
}

