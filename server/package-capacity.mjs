// Tracking gives a delivery location, not dimensions. Reserve a conservative
// fixed allowance only for USPS's explicit mailbox-delivery wording.
export const MAILBOX_PACKAGE_UNITS = 5;

export function mailboxPackageUnits(item) {
  const update = item.trackingUpdate;
  if (
    item.archived ||
    item.status !== "delivered" ||
    !item.deliveredDate ||
    update?.status !== "delivered"
  )
    return 0;
  const evidence = update.evidence || "";
  const mailboxDelivery =
    /\byour item was delivered (?:in or at|in\/at|in|at) (?:the )?mailbox\b/i.test(
      evidence,
    ) || /(?:^|[\r\n.])\s*delivered,\s*in\s*\/\s*at mailbox\b/i.test(evidence);
  return mailboxDelivery ? MAILBOX_PACKAGE_UNITS : 0;
}
