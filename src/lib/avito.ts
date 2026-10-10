import { backendRequest, backendUrl, BackendRequestError } from "./backend";

export type AvitoAccount={key:string;name:string};
export type AvitoMessage={id:string;text:string;type:string;created:number;direction:"in"|"out";isRead:boolean};
export type AvitoChat={id:string;name:string;itemTitle:string;itemUrl:string|null;lastMessage:AvitoMessage|null};
export type AvitoChatsPage={chats:AvitoChat[];offset:number;hasMore:boolean;warning?:string};
export type AvitoMessagesPage={messages:AvitoMessage[];offset:number;hasMore:boolean;warning?:string};
export type AvitoMessageEvent={chatId:string;message:AvitoMessage};
export type AvitoDeleteMessageResult={deleted:true;messageId:string;message:AvitoMessage;warning?:string};
export type AvitoWebhookStatus={enabled:boolean;accountId:string;lastEventAt:string|null};
export type AvitoOAuthStart={authorizeUrl:string;redirectUri:string};
export type AvitoOAuthResult={connected:boolean;accountKey:string;returnOrigin:string};
export type AvitoRealtimeState="connecting"|"connected"|"disconnected";
export type AvitoProfile={id:string;name:string;profileUrl:string|null};
export type AvitoItem={id:string;title:string;description:string;price:number|null;category:string;status:string;url:string|null;imageUrl:string|null};
export type AvitoItemsPage={items:AvitoItem[];page:number;hasMore:boolean;fetchedAt:string};
export type AvitoProductMetric={views:number|null;favorites:number|null;messages:number|null};
export type AvitoLink={account_id:string;item_id:string;product_id:string};
export type AvitoPublicationInput={accountKey:string;productId:string;address:string;managerName:string;contactPhone:string;reportEmail?:string;acceptAgreement:boolean};
export type AvitoPublicationResult={submitted:true;productId:string;feedUrl:string;message:string};

export class AvitoRequestError extends Error{
  constructor(message:string,public status:number|null,public code:string){super(message);this.name="AvitoRequestError"}
}
export function mergeAvitoMessages(...groups:AvitoMessage[][]):AvitoMessage[]{
  const result=new Map<string,AvitoMessage>();
  for(const message of groups.flat()){const previous=result.get(message.id);result.set(message.id,{...(previous?.type==="deleted"?previous:message),isRead:previous?.isRead===true||message.isRead})}
  return [...result.values()].sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id));
}
function cachedMessage(value:unknown):AvitoMessage|null{
  if(!value||typeof value!=="object")return null;const r=value as AvitoMessage;
  return typeof r.id==="string"&&typeof r.text==="string"&&typeof r.type==="string"&&Number.isSafeInteger(r.created)&&["in","out"].includes(r.direction)&&typeof r.isRead==="boolean"?r:null;
}

export function createAvitoRepository(){
  async function invoke<T>(body:Record<string,unknown>):Promise<T>{
    try{return await backendRequest<T>("/api/avito",{method:"POST",body:JSON.stringify(body)})}
    catch(error){if(error instanceof BackendRequestError)throw new AvitoRequestError(error.message,error.status||null,error.code);throw new AvitoRequestError("Не удалось подключиться к серверу Авито в CRM.",null,"connection_error")}
  }
  return{
    async accounts(){return(await invoke<{accounts:AvitoAccount[]}>({action:"accounts"})).accounts},
    async addAccount(input:{name:string;clientId:string;clientSecret:string}):Promise<AvitoAccount>{
      try{return(await backendRequest<{account:AvitoAccount}>("/api/avito/accounts",{method:"POST",body:JSON.stringify(input)})).account}
      catch(error){if(error instanceof BackendRequestError)throw new AvitoRequestError(error.message,error.status||null,error.code);throw new AvitoRequestError("Не удалось сохранить ключи Авито. Повторите попытку.",null,"account_save_failed")}
    },
    authorize(accountKey:string){return invoke<AvitoOAuthStart>({action:"oauth_start",accountKey})},
    completeOAuth(code:string,state:string,providerError=""){return invoke<AvitoOAuthResult>({action:"oauth_callback",code,state,...(providerError?{error:providerError}:{})})},
    webhookStatus(accountKey:string){return invoke<AvitoWebhookStatus>({action:"webhook_status",accountKey})},
    enableWebhook(accountKey:string){return invoke<AvitoWebhookStatus>({action:"enable_webhook",accountKey})},
    async chats(accountKey:string,offset=0):Promise<AvitoChatsPage>{
      try{return await invoke<AvitoChatsPage>({action:"chats",accountKey,offset})}
      catch(cause){if(cause instanceof AvitoRequestError&&["avito_auth","avito_subscription","avito_access"].includes(cause.code))throw cause;
        const rows=await backendRequest<Array<{chat_id:string;message:unknown}>>(`/api/avito/cached/chats?account_key=${encodeURIComponent(accountKey)}&offset=${offset}`).catch(()=>[]);
        if(!rows.length)throw cause;const chats=rows.map(r=>({id:String(r.chat_id),name:"Собеседник Авито",itemTitle:"",itemUrl:null,lastMessage:cachedMessage(r.message)}));
        return{chats,offset,hasMore:chats.length===50&&offset<1000,warning:"Показаны сохранённые в CRM диалоги. " +(cause instanceof Error?cause.message:"Авито временно недоступно.")};
      }
    },
    async messages(accountKey:string,chatId:string,offset=0):Promise<AvitoMessagesPage>{
      try{return await invoke<AvitoMessagesPage>({action:"chat_messages",accountKey,chatId,offset})}
      catch(cause){const values=await backendRequest<unknown[]>(`/api/avito/cached/messages?account_key=${encodeURIComponent(accountKey)}&chat_id=${encodeURIComponent(chatId)}&offset=${offset}`).catch(()=>[]);
        const messages=values.map(cachedMessage).filter((m):m is AvitoMessage=>Boolean(m));if(!messages.length)throw cause;
        return{messages,offset,hasMore:messages.length===50&&offset<1000,warning:"Показана сохранённая переписка; история может быть неполной. " +(cause instanceof Error?cause.message:"Авито временно недоступно.")};
      }
    },
    watchMessages(accountKey:string,onMessage:(event:AvitoMessageEvent)=>void,onState:(state:AvitoRealtimeState)=>void){
      onState("connecting");const url=`${backendUrl("/api/avito/events")}?account_key=${encodeURIComponent(accountKey)}`;const source=new EventSource(url,{withCredentials:true});
      source.onopen=()=>onState("connected");source.onerror=()=>onState("disconnected");
      source.addEventListener("message",(raw)=>{try{const data=JSON.parse((raw as MessageEvent<string>).data) as Record<string,unknown>;const message=cachedMessage(data.message);if(typeof data.chatId==="string"&&message)onMessage({chatId:data.chatId,message})}catch{/* Ignore malformed server events. */}});
      return()=>{source.close();onState("disconnected")};
    },
    async sendMessage(accountKey:string,chatId:string,text:string){return(await invoke<{message:AvitoMessage}>({action:"send_message",accountKey,chatId,text})).message},
    async deleteMessage(accountKey:string,chatId:string,messageId:string,created:number){const r=await invoke<AvitoDeleteMessageResult>({action:"delete_message",accountKey,chatId,messageId,created});if(r?.deleted!==true||!r.message)throw new AvitoRequestError("Сервер не подтвердил удаление сообщения.",null,"invalid_delete_response");return r.message},
    async readChat(accountKey:string,chatId:string,messageIds:string[]=[]){const r=await invoke<{read?:boolean}>({action:"read_chat",accountKey,chatId,...(messageIds.length?{messageIds:messageIds.slice(-100)}:{})});if(r?.read!==true)throw new AvitoRequestError("Сервер не подтвердил отметку прочтения.",null,"invalid_read_receipt")},
    async profile(accountKey:string){return(await invoke<{profile:AvitoProfile}>({action:"profile",accountKey})).profile},
    items(accountKey:string,page:number){return invoke<AvitoItemsPage>({action:"items",accountKey,page})},
    async productMetrics(){return(await backendRequest<{metrics:Record<string,AvitoProductMetric>}>("/api/avito/product-metrics")).metrics},
    publishItem(input:AvitoPublicationInput){return invoke<AvitoPublicationResult>({action:"publish_item",...input})},
    async downloadImage(accountKey:string,imageUrl:string):Promise<Blob>{
      let response:Response;try{response=await fetch(backendUrl("/api/avito"),{method:"POST",credentials:"include",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:"image",accountKey,imageUrl})})}catch{throw new Error("Не удалось загрузить фотографию объявления Авито. Повторите позже.")}
      if(!response.ok){const body=await response.json().catch(()=>null) as {message?:unknown}|null;throw new Error(typeof body?.message==="string"?body.message:"Не удалось загрузить фотографию объявления Авито.")}
      const type=response.headers.get("x-image-content-type")||"";const blob=await response.blob();if(blob.size>5*1024*1024||!["image/jpeg","image/png","image/webp"].includes(type))throw new Error("Авито вернуло неподдерживаемую фотографию объявления.");return blob.type===type?blob:new Blob([blob],{type});
    },
    async attachImage(_ownerId:string,productId:string,image:Blob):Promise<void>{
      const type=image.type.toLowerCase();if(!["image/jpeg","image/png","image/webp"].includes(type)||!image.size||image.size>5*1024*1024)throw new Error("Фотография объявления слишком большая или имеет неподдерживаемый формат.");
      const form=new FormData();form.set("productId",productId);form.set("file",image,`${productId}.${type==="image/png"?"png":type==="image/webp"?"webp":"jpg"}`);
      const uploaded=await backendRequest<{path:string}>("/api/files/upload",{method:"POST",body:form});
      try{await backendRequest(`/api/avito/products/${productId}/image`,{method:"PATCH",body:JSON.stringify({imagePath:uploaded.path})})}catch(error){void backendRequest(`/api/files/${uploaded.path.split("/").map(encodeURIComponent).join("/")}`,{method:"DELETE"}).catch(()=>{});throw error}
    },
    async updateImportedDescription(_ownerId:string,productId:string,description:string):Promise<void>{const value=description.trim().slice(0,20000);if(value)await backendRequest(`/api/avito/products/${productId}/description`,{method:"PATCH",body:JSON.stringify({description:value})})},
    async updatePriceForProduct(_ownerId:string,productId:string,price:number):Promise<boolean>{
      const links=await backendRequest<AvitoLink[]>(`/api/avito/links?product_id=${encodeURIComponent(productId)}`);
      for(const link of links)await invoke({action:"update_price",accountId:link.account_id,itemId:link.item_id,price});return links.length>0;
    },
    async links(_ownerId:string,accountId:string):Promise<AvitoLink[]>{return backendRequest<AvitoLink[]>(`/api/avito/links?account_id=${encodeURIComponent(accountId)}`)},
    async connectItem(accountId:string,item:AvitoItem,productId:string|null):Promise<string>{const r=await backendRequest<{productId:string}>("/api/avito/connect-item",{method:"POST",body:JSON.stringify({accountId,item,productId})});return r.productId},
  };
}
