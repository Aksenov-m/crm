import { backendRequest, backendUrl, BackendRequestError } from "./backend";
import { BUYER_STATUSES, STAGES, type Buyer, type BuyerStatus, type DemoState, type Message, type Product, type ProductStage } from "./crm";

export const PRODUCT_IMAGE_PLACEHOLDER = "/products/placeholder.svg";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BUILTIN_IMAGE = /^\/products\/(?:chair|camera|headphones|lamp|bike|coffee|speaker|console)\.jpg$/;

export interface ProductRow { id:string; owner_id:string; title:string; description:string; price:number|string; image_path:string|null; stage:Product["stage"]; category:string; views:number; favorites:number; created_at:string; sold_at:string|null }
export interface BuyerRow { id:string; owner_id:string; name:string; phone:string; product_id:string|null; status:Buyer["status"]; note:string }
export interface MessageRow { id:string; owner_id:string; buyer_id:string; text:string; direction:Message["direction"]; created_at:string; read:boolean }
export interface CrmRepository {
  load():Promise<DemoState>; saveProduct(product:Product,existing:boolean):Promise<Product>;
  changeProductStage(id:string,stage:ProductStage,soldAt?:string):Promise<Product>;
  saveBuyer(buyer:Buyer,existing:boolean):Promise<Buyer>; updateBuyerStatus(id:string,status:BuyerStatus):Promise<Buyer>;
  addMessage(message:Message):Promise<Message>; markBuyerMessagesRead(buyerId:string):Promise<void>;
}

class CrmError extends Error {}
export function getCrmErrorMessage(error:unknown):string {
  if(error instanceof CrmError)return error.message;
  if(error instanceof BackendRequestError){
    if(["related_record","23503"].includes(error.code))return "Связанный товар или покупатель больше недоступен. Обновите данные и повторите действие.";
    if(["duplicate_record","23505"].includes(error.code))return "Такая запись уже существует. Обновите данные, прежде чем повторять сохранение.";
    if(["invalid_data","23514","22P02"].includes(error.code))return "Проверьте заполненные поля: сервер отклонил некорректные данные.";
    if(error.status===401||error.status===403)return "Сеанс закончился или у вас нет доступа. Войдите в CRM снова.";
    if(error.status===413)return "Фотография слишком большая. Выберите файл до 5 МБ.";
    return error.message;
  }
  return "Не удалось подключиться к серверу CRM. Проверьте соединение и обновите данные перед повтором.";
}
function fail(message:string):never{throw new CrmError(message)}
function assertUuid(value:string){if(typeof value!=="string"||!UUID.test(value))fail("Некорректный идентификатор записи. Обновите данные.")}
function timestamp(value:string){const d=new Date(value);if(typeof value!=="string"||!Number.isFinite(d.getTime()))fail("Некорректная дата записи.");return d.toISOString()}
function builtin(path:string){return BUILTIN_IMAGE.test(path)||path===PRODUCT_IMAGE_PLACEHOLDER}
function assertImagePath(path:string,ownerId:string,productId:string){if(builtin(path))return;const p=path.split("/");if(p.length!==3||p[0]!==ownerId||p[1]!==productId||! /\.(?:jpg|png|webp)$/.test(p[2])||!UUID.test(p[2].replace(/\.(?:jpg|png|webp)$/,"")))fail("Некорректный путь фотографии. Выберите фотографию заново.")}
function assertProduct(p:Product){
  assertUuid(p.id);if(!p.title.trim()||!p.category.trim())fail("Заполните название и категорию товара.");
  if(!Number.isFinite(p.price)||p.price<0||p.price>=1e12)fail("Укажите корректную цену товара.");
  if(!STAGES.some(x=>x.id===p.stage))fail("Выберите корректный этап товара.");
  for(const n of [p.views,p.favorites])if(!Number.isInteger(n)||n<0||n>2147483647)fail("Некорректная статистика товара.");
  timestamp(p.createdAt);if(p.stage==="sold"){if(!p.soldAt)fail("Для проданного товара нужна дата продажи.");timestamp(p.soldAt)}
}
function pathImage(path:string){return `${backendUrl("/api/files")}/${path.split("/").map(encodeURIComponent).join("/")}`}

export function mapProductRow(r:ProductRow,image?:string):Product{
  assertUuid(r.id);assertUuid(r.owner_id);if(r.image_path)assertImagePath(r.image_path,r.owner_id,r.id);
  const p:Product={id:r.id,title:r.title,description:r.description,price:Number(r.price),image:image||(r.image_path?(builtin(r.image_path)?r.image_path:pathImage(r.image_path)):PRODUCT_IMAGE_PLACEHOLDER),...(r.image_path?{imagePath:r.image_path}:{}),stage:r.stage,category:r.category,views:r.views,favorites:r.favorites,createdAt:timestamp(r.created_at),...(r.sold_at?{soldAt:timestamp(r.sold_at)}:{})};
  assertProduct(p);if((r.stage==="sold")!==Boolean(r.sold_at))fail("Дата продажи не соответствует этапу товара.");return p;
}
export function mapBuyerRow(r:BuyerRow):Buyer{assertUuid(r.id);if(r.product_id)assertUuid(r.product_id);if(!r.name.trim()||!BUYER_STATUSES.some(x=>x.id===r.status))fail("Некорректные данные покупателя.");return{id:r.id,name:r.name,phone:r.phone,productId:r.product_id||"",status:r.status,note:r.note}}
export function mapMessageRow(r:MessageRow):Message{assertUuid(r.id);assertUuid(r.buyer_id);if(!r.text.trim()||!["incoming","outgoing"].includes(r.direction)||typeof r.read!=="boolean")fail("Некорректные данные сообщения.");return{id:r.id,buyerId:r.buyer_id,text:r.text,direction:r.direction,createdAt:timestamp(r.created_at),read:r.read}}

function jpegBlob(dataUrl:string):Blob{
  const prefix="data:image/jpeg;base64,";if(!dataUrl.startsWith(prefix))fail("Выберите фотографию JPEG, PNG или WebP заново.");
  const encoded=dataUrl.slice(prefix.length);if(!encoded||encoded.length>Math.ceil(MAX_IMAGE_BYTES/3)*4||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))fail("Некорректная или слишком большая фотография.");
  let decoded:string;try{decoded=atob(encoded)}catch{return fail("Не удалось прочитать фотографию. Выберите файл заново.")}
  const bytes=Uint8Array.from(decoded,c=>c.charCodeAt(0));if(bytes.length>MAX_IMAGE_BYTES||bytes.length<5||bytes[0]!==255||bytes[1]!==216||bytes[2]!==255||bytes.at(-2)!==255||bytes.at(-1)!==217)fail("Не удалось прочитать JPEG-фотографию. Выберите файл заново.");return new Blob([bytes],{type:"image/jpeg"});
}
function apiProduct(value:unknown,ownerId:string):ProductRow{const r=value as Record<string,unknown>;return{id:String(r.id),owner_id:ownerId,title:String(r.title),description:String(r.description||""),price:r.price as number|string,image_path:typeof r.imagePath==="string"?r.imagePath:null,stage:r.stage as Product["stage"],category:String(r.category),views:Number(r.views),favorites:Number(r.favorites),created_at:String(r.createdAt),sold_at:typeof r.soldAt==="string"?r.soldAt:null}}
function apiBuyer(value:unknown,ownerId:string):BuyerRow{const r=value as Record<string,unknown>;return{id:String(r.id),owner_id:ownerId,name:String(r.name),phone:String(r.phone||""),product_id:typeof r.productId==="string"&&r.productId?r.productId:null,status:r.status as Buyer["status"],note:String(r.note||"")}}
function apiMessage(value:unknown,ownerId:string):MessageRow{const r=value as Record<string,unknown>;return{id:String(r.id),owner_id:ownerId,buyer_id:String(r.buyerId),text:String(r.text),direction:r.direction as Message["direction"],created_at:String(r.createdAt),read:r.read===true}}

export function createCrmRepository(ownerId:string):CrmRepository{
  assertUuid(ownerId);
  return{
    async load(){const state=await backendRequest<{products:unknown[];buyers:unknown[];messages:unknown[]}>("/api/crm");return{version:1,products:state.products.map(x=>mapProductRow(apiProduct(x,ownerId))),buyers:state.buyers.map(x=>mapBuyerRow(apiBuyer(x,ownerId))),messages:state.messages.map(x=>mapMessageRow(apiMessage(x,ownerId)))}} ,
    async saveProduct(product,existing){
      assertProduct(product);let imagePath:string|null=null;let uploadedPath="";
      try{
        if(product.image.startsWith("data:")){const form=new FormData();form.set("productId",product.id);form.set("file",jpegBlob(product.image),`${product.id}.jpg`);const uploaded=await backendRequest<{path:string}>("/api/files/upload",{method:"POST",body:form});imagePath=uploaded.path;uploadedPath=uploaded.path}
        else if(product.imagePath&&(product.image===PRODUCT_IMAGE_PLACEHOLDER||!builtin(product.image))){imagePath=product.imagePath;assertImagePath(imagePath,ownerId,product.id)}
        else if(builtin(product.image))imagePath=product.image===PRODUCT_IMAGE_PLACEHOLDER?null:product.image;
        else if(product.image)fail("Выберите фотографию заново: внешние ссылки не сохраняются в CRM.");
        const body={...product,title:product.title.trim(),category:product.category.trim(),imagePath};
        const result=await backendRequest(`/api/crm/products${existing?`/${product.id}`:""}`,{method:existing?"PUT":"POST",body:JSON.stringify(body)});
        return mapProductRow(apiProduct(result,ownerId));
      }catch(error){if(uploadedPath){const path=`/api/files/${uploadedPath.split("/").map(encodeURIComponent).join("/")}`;void backendRequest(path,{method:"DELETE"}).catch(()=>{})}throw error instanceof CrmError?error:new CrmError(getCrmErrorMessage(error))}
    },
    async changeProductStage(id,stage,soldAt){assertUuid(id);if(!STAGES.some(x=>x.id===stage))fail("Выберите корректный этап товара.");if(stage==="sold"&&!soldAt)fail("Для проданного товара нужна дата продажи.");const r=await backendRequest(`/api/crm/products/${id}/stage`,{method:"PATCH",body:JSON.stringify({stage,soldAt:stage==="sold"?timestamp(soldAt!):null})});return mapProductRow(apiProduct(r,ownerId))},
    async saveBuyer(buyer,existing){const r=await backendRequest(`/api/crm/buyers${existing?`/${buyer.id}`:""}`,{method:existing?"PUT":"POST",body:JSON.stringify({...buyer,name:buyer.name.trim()})});return mapBuyerRow(apiBuyer(r,ownerId))},
    async updateBuyerStatus(id,status){assertUuid(id);if(!BUYER_STATUSES.some(x=>x.id===status))fail("Выберите корректный статус покупателя.");const r=await backendRequest(`/api/crm/buyers/${id}/status`,{method:"PATCH",body:JSON.stringify({status})});return mapBuyerRow(apiBuyer(r,ownerId))},
    async addMessage(message){const r=await backendRequest("/api/crm/messages",{method:"POST",body:JSON.stringify({...message,text:message.text.trim()})});return mapMessageRow(apiMessage(r,ownerId))},
    async markBuyerMessagesRead(id){assertUuid(id);await backendRequest(`/api/crm/buyers/${id}/messages-read`,{method:"PATCH",body:JSON.stringify({})})},
  }
}
