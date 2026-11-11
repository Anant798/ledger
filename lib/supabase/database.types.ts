
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "ai_conversations": {
                  Row: {
                    "created_at": string,"id": string,"title": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"title": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"title"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"ai_messages": {
                  Row: {
                    "content": string,"conversation_id": string,"created_at": string,"id": string,"metadata": NonNullable<Json>,"role": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "content": string,"conversation_id": string,"created_at"?: string,"id"?: string,"metadata"?: NonNullable<Json>,"role": string,"user_id": string
                  }
                  Update: {
                    "content"?: string,"conversation_id"?: string,"created_at"?: string,"id"?: string,"metadata"?: NonNullable<Json>,"role"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ai_messages_conversation_id_fkey"
      columns: ["conversation_id"]
isOneToOne: false
      referencedRelation: "ai_conversations"
      referencedColumns: ["id"]
    }
                  ]
                },"alerts": {
                  Row: {
                    "alert_type": string,"created_at": string,"id": string,"import_review_id": string | null,"is_read": boolean,"is_resolved": boolean,"message": string,"resolved_at": string | null,"title": string,"transaction_id": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "alert_type"?: string,"created_at"?: string,"id"?: string,"import_review_id"?: string | null,"is_read"?: boolean,"is_resolved"?: boolean,"message": string,"resolved_at"?: string | null,"title": string,"transaction_id"?: string | null,"user_id": string
                  }
                  Update: {
                    "alert_type"?: string,"created_at"?: string,"id"?: string,"import_review_id"?: string | null,"is_read"?: boolean,"is_resolved"?: boolean,"message"?: string,"resolved_at"?: string | null,"title"?: string,"transaction_id"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "alerts_import_review_id_fkey"
      columns: ["import_review_id"]
isOneToOne: false
      referencedRelation: "import_review_queue"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "alerts_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    }
                  ]
                },"expense_groups": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"currency_code": string,"id": string,"split_method": string,"title": string,"total_amount": number,"transaction_id": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"currency_code"?: string,"id"?: string,"split_method"?: string,"title": string,"total_amount": number,"transaction_id"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"currency_code"?: string,"id"?: string,"split_method"?: string,"title"?: string,"total_amount"?: number,"transaction_id"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "expense_groups_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    }
                  ]
                },"expense_shares": {
                  Row: {
                    "amount_owed": number,"created_at": string,"email": string | null,"expense_group_id": string,"id": string,"is_active": boolean,"participant_name": string,"participant_type": string,"participant_user_id": string | null,"phone_number": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount_owed": number,"created_at"?: string,"email"?: string | null,"expense_group_id": string,"id"?: string,"is_active"?: boolean,"participant_name": string,"participant_type"?: string,"participant_user_id"?: string | null,"phone_number"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "amount_owed"?: number,"created_at"?: string,"email"?: string | null,"expense_group_id"?: string,"id"?: string,"is_active"?: boolean,"participant_name"?: string,"participant_type"?: string,"participant_user_id"?: string | null,"phone_number"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "expense_shares_expense_group_id_fkey"
      columns: ["expense_group_id"]
isOneToOne: false
      referencedRelation: "expense_groups"
      referencedColumns: ["id"]
    }
                  ]
                },"goal_contributions": {
                  Row: {
                    "amount": number,"contributed_at": string,"contribution_source": string,"contribution_status": string,"created_at": string,"goal_id": string,"id": string,"idempotency_key": string | null,"manually_reversed_at": string | null,"notes": string | null,"reversed_by_user_id": string | null,"source_amount": number | null,"transaction_id": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"contributed_at"?: string,"contribution_source"?: string,"contribution_status"?: string,"created_at"?: string,"goal_id": string,"id"?: string,"idempotency_key"?: string | null,"manually_reversed_at"?: string | null,"notes"?: string | null,"reversed_by_user_id"?: string | null,"source_amount"?: number | null,"transaction_id"?: string | null,"user_id": string
                  }
                  Update: {
                    "amount"?: number,"contributed_at"?: string,"contribution_source"?: string,"contribution_status"?: string,"created_at"?: string,"goal_id"?: string,"id"?: string,"idempotency_key"?: string | null,"manually_reversed_at"?: string | null,"notes"?: string | null,"reversed_by_user_id"?: string | null,"source_amount"?: number | null,"transaction_id"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "goal_contributions_goal_id_fkey"
      columns: ["goal_id"]
isOneToOne: false
      referencedRelation: "savings_goals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "goal_contributions_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    }
                  ]
                },"import_review_queue": {
                  Row: {
                    "account_last4": string | null,"amount": number | null,"bank_name": string | null,"category": string | null,"confidence": number | null,"created_at": string,"created_transaction_id": string | null,"currency_code": string | null,"description": string | null,"direction": string | null,"email_message_id": string | null,"external_reference": string | null,"id": string,"merchant_name": string | null,"occurred_at": string,"occurred_at_source": string | null,"payment_provider": string | null,"raw_snippet": string | null,"resolved_at": string | null,"review_status": string,"transaction_type": string,"uncertain_reason": string | null,"updated_at": string,"upi_id": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_last4"?: string | null,"amount"?: number | null,"bank_name"?: string | null,"category"?: string | null,"confidence"?: number | null,"created_at"?: string,"created_transaction_id"?: string | null,"currency_code"?: string | null,"description"?: string | null,"direction"?: string | null,"email_message_id"?: string | null,"external_reference"?: string | null,"id"?: string,"merchant_name"?: string | null,"occurred_at"?: string,"occurred_at_source"?: string | null,"payment_provider"?: string | null,"raw_snippet"?: string | null,"resolved_at"?: string | null,"review_status"?: string,"transaction_type"?: string,"uncertain_reason"?: string | null,"updated_at"?: string,"upi_id"?: string | null,"user_id": string
                  }
                  Update: {
                    "account_last4"?: string | null,"amount"?: number | null,"bank_name"?: string | null,"category"?: string | null,"confidence"?: number | null,"created_at"?: string,"created_transaction_id"?: string | null,"currency_code"?: string | null,"description"?: string | null,"direction"?: string | null,"email_message_id"?: string | null,"external_reference"?: string | null,"id"?: string,"merchant_name"?: string | null,"occurred_at"?: string,"occurred_at_source"?: string | null,"payment_provider"?: string | null,"raw_snippet"?: string | null,"resolved_at"?: string | null,"review_status"?: string,"transaction_type"?: string,"uncertain_reason"?: string | null,"updated_at"?: string,"upi_id"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "fk_import_review_processed_email"
      columns: ["user_id","email_message_id"]
isOneToOne: false
      referencedRelation: "processed_emails"
      referencedColumns: ["user_id","message_id"]
    },{
      foreignKeyName: "import_review_queue_created_transaction_id_fkey"
      columns: ["created_transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    }
                  ]
                },"ledger_events": {
                  Row: {
                    "created_at": string,"description": string | null,"event_source": string,"event_type": string,"external_event_id": string | null,"id": string,"metadata": NonNullable<Json>,"occurred_at": string,"transaction_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"description"?: string | null,"event_source"?: string,"event_type": string,"external_event_id"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"occurred_at"?: string,"transaction_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"description"?: string | null,"event_source"?: string,"event_type"?: string,"external_event_id"?: string | null,"id"?: string,"metadata"?: NonNullable<Json>,"occurred_at"?: string,"transaction_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "ledger_events_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    }
                  ]
                },"processed_emails": {
                  Row: {
                    "created_at": string,"history_id": string | null,"id": string,"internal_date": string | null,"message_id": string,"processing_started_at": string | null,"sender": string | null,"status": string,"subject": string | null,"transaction_id": string | null,"uncertain_reason": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"history_id"?: string | null,"id"?: string,"internal_date"?: string | null,"message_id": string,"processing_started_at"?: string | null,"sender"?: string | null,"status": string,"subject"?: string | null,"transaction_id"?: string | null,"uncertain_reason"?: string | null,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"history_id"?: string | null,"id"?: string,"internal_date"?: string | null,"message_id"?: string,"processing_started_at"?: string | null,"sender"?: string | null,"status"?: string,"subject"?: string | null,"transaction_id"?: string | null,"uncertain_reason"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "processed_emails_transaction_id_fkey"
      columns: ["transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    }
                  ]
                },"profiles": {
                  Row: {
                    "avatar_url": string | null,"created_at": string,"date_of_birth": string | null,"email": string | null,"full_name": string | null,"id": string,"preferred_language": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "avatar_url"?: string | null,"created_at"?: string,"date_of_birth"?: string | null,"email"?: string | null,"full_name"?: string | null,"id": string,"preferred_language"?: string,"updated_at"?: string
                  }
                  Update: {
                    "avatar_url"?: string | null,"created_at"?: string,"date_of_birth"?: string | null,"email"?: string | null,"full_name"?: string | null,"id"?: string,"preferred_language"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"reminder_attempts": {
                  Row: {
                    "attempt_number": number,"attempted_at": string,"error": string | null,"id": string,"next_attempt_at": string | null,"outcome": string,"reminder_log_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_number": number,"attempted_at"?: string,"error"?: string | null,"id"?: string,"next_attempt_at"?: string | null,"outcome": string,"reminder_log_id": string,"user_id": string
                  }
                  Update: {
                    "attempt_number"?: number,"attempted_at"?: string,"error"?: string | null,"id"?: string,"next_attempt_at"?: string | null,"outcome"?: string,"reminder_log_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reminder_attempts_reminder_log_id_fkey"
      columns: ["reminder_log_id"]
isOneToOne: false
      referencedRelation: "reminder_logs"
      referencedColumns: ["id"]
    }
                  ]
                },"reminder_logs": {
                  Row: {
                    "attempt_count": number,"created_at": string,"delivery_status": string,"expense_share_id": string,"id": string,"idempotency_key": string,"last_error": string | null,"lease_until": string | null,"max_attempts": number,"reminder_sequence": number,"scheduled_for": string,"sent_at": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempt_count"?: number,"created_at"?: string,"delivery_status"?: string,"expense_share_id": string,"id"?: string,"idempotency_key": string,"last_error"?: string | null,"lease_until"?: string | null,"max_attempts"?: number,"reminder_sequence"?: number,"scheduled_for": string,"sent_at"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "attempt_count"?: number,"created_at"?: string,"delivery_status"?: string,"expense_share_id"?: string,"id"?: string,"idempotency_key"?: string,"last_error"?: string | null,"lease_until"?: string | null,"max_attempts"?: number,"reminder_sequence"?: number,"scheduled_for"?: string,"sent_at"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "reminder_logs_expense_share_id_fkey"
      columns: ["expense_share_id"]
isOneToOne: false
      referencedRelation: "expense_shares"
      referencedColumns: ["id"]
    }
                  ]
                },"reminder_settings": {
                  Row: {
                    "enabled": boolean,"frequency_hours": number,"max_attempts": number,"preferred_send_time": string,"timezone": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "enabled"?: boolean,"frequency_hours"?: number,"max_attempts"?: number,"preferred_send_time"?: string,"timezone"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "enabled"?: boolean,"frequency_hours"?: number,"max_attempts"?: number,"preferred_send_time"?: string,"timezone"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"repayment_events": {
                  Row: {
                    "created_at": string,"event_source": string,"event_type": string,"id": string,"idempotency_key": string | null,"metadata": NonNullable<Json>,"repayment_id": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"event_source"?: string,"event_type": string,"id"?: string,"idempotency_key"?: string | null,"metadata"?: NonNullable<Json>,"repayment_id": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"event_source"?: string,"event_type"?: string,"id"?: string,"idempotency_key"?: string | null,"metadata"?: NonNullable<Json>,"repayment_id"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repayment_events_repayment_id_fkey"
      columns: ["repayment_id"]
isOneToOne: false
      referencedRelation: "repayments"
      referencedColumns: ["id"]
    }
                  ]
                },"repayments": {
                  Row: {
                    "amount": number,"confirmation_source": string | null,"confirmed_at": string | null,"created_at": string,"currency_code": string,"expense_share_id": string,"external_reference": string | null,"id": string,"idempotency_key": string | null,"payment_method": string | null,"payment_provider": string | null,"payment_status": string,"reversal_reason": string | null,"reversed_at": string | null,"reversed_by": string | null,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"confirmation_source"?: string | null,"confirmed_at"?: string | null,"created_at"?: string,"currency_code"?: string,"expense_share_id": string,"external_reference"?: string | null,"id"?: string,"idempotency_key"?: string | null,"payment_method"?: string | null,"payment_provider"?: string | null,"payment_status"?: string,"reversal_reason"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "amount"?: number,"confirmation_source"?: string | null,"confirmed_at"?: string | null,"created_at"?: string,"currency_code"?: string,"expense_share_id"?: string,"external_reference"?: string | null,"id"?: string,"idempotency_key"?: string | null,"payment_method"?: string | null,"payment_provider"?: string | null,"payment_status"?: string,"reversal_reason"?: string | null,"reversed_at"?: string | null,"reversed_by"?: string | null,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "repayments_expense_share_id_fkey"
      columns: ["expense_share_id"]
isOneToOne: false
      referencedRelation: "expense_shares"
      referencedColumns: ["id"]
    }
                  ]
                },"savings_contribution_events": {
                  Row: {
                    "after_state": Json | null,"before_state": Json | null,"contribution_id": string,"created_at": string,"event_type": string,"goal_id": string,"id": string,"reason": string | null,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "after_state"?: Json | null,"before_state"?: Json | null,"contribution_id": string,"created_at"?: string,"event_type": string,"goal_id": string,"id"?: string,"reason"?: string | null,"user_id": string
                  }
                  Update: {
                    "after_state"?: Json | null,"before_state"?: Json | null,"contribution_id"?: string,"created_at"?: string,"event_type"?: string,"goal_id"?: string,"id"?: string,"reason"?: string | null,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "savings_contribution_events_contribution_id_fkey"
      columns: ["contribution_id"]
isOneToOne: false
      referencedRelation: "goal_contributions"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "savings_contribution_events_goal_id_fkey"
      columns: ["goal_id"]
isOneToOne: false
      referencedRelation: "savings_goals"
      referencedColumns: ["id"]
    }
                  ]
                },"savings_goal_rules": {
                  Row: {
                    "amount": number,"created_at": string,"day_of_month": number,"enabled": boolean,"frequency": string,"goal_id": string,"id": string,"last_run_at": string | null,"next_run_at": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "amount": number,"created_at"?: string,"day_of_month"?: number,"enabled"?: boolean,"frequency": string,"goal_id": string,"id"?: string,"last_run_at"?: string | null,"next_run_at"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "amount"?: number,"created_at"?: string,"day_of_month"?: number,"enabled"?: boolean,"frequency"?: string,"goal_id"?: string,"id"?: string,"last_run_at"?: string | null,"next_run_at"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "savings_goal_rules_goal_id_fkey"
      columns: ["goal_id"]
isOneToOne: true
      referencedRelation: "savings_goals"
      referencedColumns: ["id"]
    }
                  ]
                },"savings_goals": {
                  Row: {
                    "created_at": string,"currency_code": string,"current_amount": number,"deleted_at": string | null,"description": string | null,"id": string,"status": string,"target_amount": number,"target_date": string | null,"title": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"currency_code"?: string,"current_amount"?: number,"deleted_at"?: string | null,"description"?: string | null,"id"?: string,"status"?: string,"target_amount": number,"target_date"?: string | null,"title": string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"currency_code"?: string,"current_amount"?: number,"deleted_at"?: string | null,"description"?: string | null,"id"?: string,"status"?: string,"target_amount"?: number,"target_date"?: string | null,"title"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"server_oauth_tokens": {
                  Row: {
                    "access_token": string,"created_at": string,"email_address": string | null,"history_id": string | null,"history_page_token": string | null,"id": string,"initial_sync_completed": boolean,"last_error": string | null,"last_synced_at": string | null,"next_page_token": string | null,"provider": string,"refresh_token": string | null,"scope": string | null,"sync_lease_until": string | null,"sync_status": string,"token_expiry": string | null,"updated_at": string,"user_id": string,"watch_expiration": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "access_token": string,"created_at"?: string,"email_address"?: string | null,"history_id"?: string | null,"history_page_token"?: string | null,"id"?: string,"initial_sync_completed"?: boolean,"last_error"?: string | null,"last_synced_at"?: string | null,"next_page_token"?: string | null,"provider": string,"refresh_token"?: string | null,"scope"?: string | null,"sync_lease_until"?: string | null,"sync_status"?: string,"token_expiry"?: string | null,"updated_at"?: string,"user_id": string,"watch_expiration"?: string | null
                  }
                  Update: {
                    "access_token"?: string,"created_at"?: string,"email_address"?: string | null,"history_id"?: string | null,"history_page_token"?: string | null,"id"?: string,"initial_sync_completed"?: boolean,"last_error"?: string | null,"last_synced_at"?: string | null,"next_page_token"?: string | null,"provider"?: string,"refresh_token"?: string | null,"scope"?: string | null,"sync_lease_until"?: string | null,"sync_status"?: string,"token_expiry"?: string | null,"updated_at"?: string,"user_id"?: string,"watch_expiration"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"transactions": {
                  Row: {
                    "account_last4": string | null,"amount": number,"bank_name": string | null,"category": string | null,"created_at": string,"currency_code": string,"deleted_at": string | null,"description": string | null,"direction": string,"external_reference": string | null,"id": string,"merchant_name": string | null,"occurred_at": string,"occurred_at_source": string | null,"payment_method": string | null,"payment_provider": string | null,"related_transaction_id": string | null,"status": string,"transaction_type": string,"updated_at": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "account_last4"?: string | null,"amount": number,"bank_name"?: string | null,"category"?: string | null,"created_at"?: string,"currency_code"?: string,"deleted_at"?: string | null,"description"?: string | null,"direction": string,"external_reference"?: string | null,"id"?: string,"merchant_name"?: string | null,"occurred_at"?: string,"occurred_at_source"?: string | null,"payment_method"?: string | null,"payment_provider"?: string | null,"related_transaction_id"?: string | null,"status"?: string,"transaction_type"?: string,"updated_at"?: string,"user_id": string
                  }
                  Update: {
                    "account_last4"?: string | null,"amount"?: number,"bank_name"?: string | null,"category"?: string | null,"created_at"?: string,"currency_code"?: string,"deleted_at"?: string | null,"description"?: string | null,"direction"?: string,"external_reference"?: string | null,"id"?: string,"merchant_name"?: string | null,"occurred_at"?: string,"occurred_at_source"?: string | null,"payment_method"?: string | null,"payment_provider"?: string | null,"related_transaction_id"?: string | null,"status"?: string,"transaction_type"?: string,"updated_at"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "transactions_related_transaction_id_fkey"
      columns: ["related_transaction_id"]
isOneToOne: false
      referencedRelation: "transactions"
      referencedColumns: ["id"]
    }
                  ]
                },"webhook_events": {
                  Row: {
                    "created_at": string,"error_message": string | null,"event_type": string,"id": string,"last_error": string | null,"payload": NonNullable<Json>,"processed_at": string | null,"processing_started_at": string | null,"processing_status": string,"provider": string,"provider_event_id": string,"received_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"error_message"?: string | null,"event_type": string,"id"?: string,"last_error"?: string | null,"payload"?: NonNullable<Json>,"processed_at"?: string | null,"processing_started_at"?: string | null,"processing_status"?: string,"provider": string,"provider_event_id": string,"received_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"error_message"?: string | null,"event_type"?: string,"id"?: string,"last_error"?: string | null,"payload"?: NonNullable<Json>,"processed_at"?: string | null,"processing_started_at"?: string | null,"processing_status"?: string,"provider"?: string,"provider_event_id"?: string,"received_at"?: string
                  }
                  Relationships: [
                    
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "add_automated_goal_contribution":
{ Args: { "p_amount": number,"p_goal_id": string,"p_idempotency_key": string,"p_notes": string,"p_user_id": string }; Returns: Json
                           },
"add_transaction_goal_contribution":
{ Args: { "p_amount": number,"p_goal_id": string,"p_notes": string,"p_transaction_id": string,"p_user_id": string }; Returns: Json
                           },
"approve_review_queue_item":
{ Args: { "p_amount"?: number,"p_bank_name"?: string,"p_description"?: string,"p_direction"?: string,"p_merchant_name"?: string,"p_payment_provider"?: string,"p_review_id": string,"p_user_id": string }; Returns: Json
                           },
"archive_savings_goal":
{ Args: { "p_goal_id": string,"p_user_id": string }; Returns: boolean
                           },
"archive_transaction_with_event":
{ Args: { "p_transaction_id": string,"p_user_id": string }; Returns: Json
                           },
"cancel_expense_reminders_for_share":
{ Args: { "p_share": string }; Returns: number
                           },
"cancel_user_expense_reminders":
{ Args: { "p_user_id": string }; Returns: number
                           },
"claim_due_expense_reminders":
{ Args: { "p_lease_seconds"?: number,"p_limit"?: number }; Returns: {
              "attempt_count": number,
"created_at": string,
"delivery_status": string,
"expense_share_id": string,
"id": string,
"idempotency_key": string,
"last_error": string | null,
"lease_until": string | null,
"max_attempts": number,
"reminder_sequence": number,
"scheduled_for": string,
"sent_at": string | null,
"updated_at": string,
"user_id": string
            }[]
                          SetofOptions: {
        from: "*"
        to: "reminder_logs"
        isOneToOne: false
        isSetofReturn: true
      } },
"claim_gmail_sync":
{ Args: { "p_lease_seconds"?: number,"p_user_id": string }; Returns: boolean
                           },
"claim_gmail_webhook_event":
{ Args: { "p_event_id": string,"p_event_type": string,"p_payload": Json,"p_provider": string }; Returns: boolean
                           },
"claim_processed_email":
{ Args: { "p_history_id": string,"p_internal_date": string,"p_message_id": string,"p_sender": string,"p_subject": string,"p_user_id": string }; Returns: boolean
                           },
"complete_gmail_import":
{ Args: { "p_message_id": string,"p_metadata"?: Json,"p_transaction": Json,"p_user_id": string }; Returns: Json
                           },
"complete_gmail_review":
{ Args: { "p_message_id": string,"p_review": Json,"p_user_id": string }; Returns: string
                           },
"complete_savings_goal":
{ Args: { "p_goal_id": string,"p_user_id": string }; Returns: Json
                           },
"create_manual_transaction_with_event":
{ Args: { "p_transaction": Json,"p_user_id": string }; Returns: Json
                           },
"create_shared_expense_group":
{ Args: { "p_group": Json,"p_shares": Json,"p_user_id": string }; Returns: Json
                           },
"finish_expense_reminder_attempt":
{ Args: { "p_error"?: string,"p_next_attempt_at"?: string,"p_outcome": string,"p_reminder_id": string }; Returns: boolean
                           },
"finish_gmail_webhook_event":
{ Args: { "p_error"?: string,"p_event_id": string,"p_provider": string,"p_status": string }; Returns: undefined
                           },
"finish_processed_email":
{ Args: { "p_message_id": string,"p_reason"?: string,"p_status": string,"p_user_id": string }; Returns: undefined
                           },
"get_transaction_summary":
{ Args: { "p_user_id": string }; Returns: Json
                           },
"is_expense_group_participant":
{ Args: { "p_group_id": string,"p_user_id": string }; Returns: boolean
                           },
"next_expense_reminder_time":
{ Args: { "p_after": string,"p_preferred_send_time": string,"p_timezone": string }; Returns: string
                           },
"reconcile_goal_contribution_refunds":
{ Args: { "p_source_transaction_id": string }; Returns: undefined
                           },
"reconcile_savings_goal_completion":
{ Args: { "p_goal_id": string,"p_user_id": string }; Returns: undefined
                           },
"record_manual_goal_contribution":
{ Args: { "p_amount": number,"p_contributed_at": string,"p_goal_id": string,"p_notes": string,"p_user_id": string }; Returns: Json
                           },
"record_shared_expense_repayment":
{ Args: { "p_amount": number,"p_currency_code": string,"p_external_reference": string,"p_payment_method": string,"p_payment_provider": string,"p_share_id": string,"p_user_id": string }; Returns: Json
                           } |
{ Args: { "p_amount": number,"p_currency_code": string,"p_external_reference": string,"p_idempotency_key": string,"p_payment_method": string,"p_payment_provider": string,"p_share_id": string,"p_user_id": string }; Returns: Json
                           },
"reject_review_queue_item":
{ Args: { "p_review_id": string,"p_user_id": string }; Returns: Json
                           },
"reschedule_expense_reminders":
{ Args: { "p_user_id": string }; Returns: number
                           },
"resolve_gmail_import_review":
{ Args: { "p_action": string,"p_corrections"?: Json,"p_review_id": string,"p_user_id": string }; Returns: Json
                           },
"reverse_savings_contribution":
{ Args: { "p_contribution_id": string,"p_reason": string,"p_user_id": string }; Returns: Json
                           },
"reverse_shared_expense_repayment":
{ Args: { "p_reason": string,"p_repayment_id": string,"p_user_id": string }; Returns: Json
                           },
"run_due_savings_goal_rules":
{ Args: { "p_limit"?: number }; Returns: number
                           },
"schedule_all_expense_reminders":
{ Args: Record<PropertyKey, never>; Returns: number
                           },
"schedule_expense_reminders":
{ Args: { "p_user_id": string }; Returns: number
                           },
"set_expense_group_archived":
{ Args: { "p_archived": boolean,"p_group_id": string,"p_user_id": string }; Returns: Json
                           },
"update_manual_transaction_with_event":
{ Args: { "p_transaction_id": string,"p_updates": Json,"p_user_id": string }; Returns: Json
                           },
"update_savings_contribution":
{ Args: { "p_amount": number,"p_contribution_id": string,"p_notes": string,"p_update_notes": boolean,"p_user_id": string }; Returns: Json
                           },
"update_shared_expense_group":
{ Args: { "p_group": Json,"p_group_id": string,"p_shares": Json,"p_user_id": string }; Returns: Json
                           },
"update_shared_expense_repayment":
{ Args: { "p_amount": number,"p_idempotency_key": string,"p_payment_method": string,"p_payment_provider": string,"p_repayment_id": string,"p_user_id": string }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            
          }
        }
} as const
