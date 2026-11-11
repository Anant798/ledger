SELECT
    uncertain_reason,
    COUNT(*) AS message_count
FROM public.processed_emails
WHERE status = 'failed'
GROUP BY uncertain_reason
ORDER BY message_count DESC;