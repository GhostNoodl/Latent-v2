export interface SetupActivity {
 id:string; at:string; updatedAt:string; name:string; source:string; destination:string;
 state:'active'|'completed'|'failed'|'cancelled'|'interrupted'; message:string; details?:string; progress?:number;
}
