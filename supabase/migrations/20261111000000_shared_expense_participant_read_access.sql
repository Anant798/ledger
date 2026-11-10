-- Allow an explicitly linked Ledger participant to read the group and its
-- settlement history. All write policies and mutation RPCs remain owner-only.
CREATE OR REPLACE FUNCTION public.is_expense_group_participant(p_group_id uuid,p_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT auth.uid() IS NOT NULL
     AND auth.uid()=p_user_id
     AND EXISTS (SELECT 1 FROM public.expense_shares s
       WHERE s.expense_group_id=p_group_id AND s.participant_user_id=p_user_id);
$$;
REVOKE ALL ON FUNCTION public.is_expense_group_participant(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_expense_group_participant(uuid,uuid) TO authenticated, service_role;

CREATE POLICY "Participants can view shared expense groups"
  ON public.expense_groups FOR SELECT TO authenticated
  USING (public.is_expense_group_participant(id,(SELECT auth.uid())));

CREATE POLICY "Participants can view shares in shared expense groups"
  ON public.expense_shares FOR SELECT TO authenticated
  USING (public.is_expense_group_participant(expense_group_id,(SELECT auth.uid())));

CREATE POLICY "Participants can view shared expense repayments"
  ON public.repayments FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.expense_shares s
    WHERE s.id=repayments.expense_share_id
      AND public.is_expense_group_participant(s.expense_group_id,(SELECT auth.uid()))
  ));

CREATE POLICY "Participants can view shared repayment events"
  ON public.repayment_events FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.repayments r JOIN public.expense_shares s ON s.id=r.expense_share_id
    WHERE r.id=repayment_events.repayment_id
      AND public.is_expense_group_participant(s.expense_group_id,(SELECT auth.uid()))
  ));
