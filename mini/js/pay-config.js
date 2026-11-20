/* PropLync Mini · how customers pay (manual, until Mercado Pago is connected)
   ─────────────────────────────────────────────────────────────────
   WHY A FILE OF ITS OWN: these are the only business details the panel shows
   that change without a code change in logic. Fill them in and redeploy.
   While `clabe` is empty the panel does not invent account details: it offers
   "Pedir datos de pago", which reaches the operator like a payment notice.
   The amount and period come from api/_lib/plans.js on the server; these only
   decide what the customer reads. */
var MINI_PAY = {
  amount: 249,          // MXN, must match MINI_PRICE_MXN in api/_lib/plans.js
  periodEs: '3 meses',
  periodEn: '3 months',
  holder: '',           // account holder name
  bank: '',             // bank name
  clabe: '',            // 18-digit CLABE for SPEI transfers
  whatsapp: ''          // optional: number customers can message about payments, digits with country code
};
