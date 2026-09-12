<script setup lang="ts">
import { computed, reactive, ref, useId } from 'vue';
import { KeyRound } from '@lucide/vue';
import { localAuthenticationCredentialsSchema } from '@moirai/shared/api-contracts';
import { useFieldValidation } from '../field-validation';
import { errorMessage } from '../error-message';
import PageHeader from '../components/PageHeader.vue';
import TransientToast from '../components/TransientToast.vue';
import { useAuthenticationStore } from '../stores/authentication';

const authentication = useAuthenticationStore();
const localCredentials = reactive({
	username: authentication.state?.localUsername ?? '',
	currentPassword: '',
	password: '',
	confirmation: '',
});
const savingCredentials = ref(false);
const credentialMessage = ref('');
const credentialError = ref('');
const hasLocalAccount = computed(() => authentication.state?.methods.local === true);
const passwordHelpId = useId();
const credentialValidationResult = computed(() => {
	const result = localAuthenticationCredentialsSchema.safeParse({
		username: localCredentials.username,
		password: localCredentials.password,
		currentPassword: hasLocalAccount.value ? localCredentials.currentPassword : null,
	});
	const issues = [...(result.error?.issues ?? [])];
	if (localCredentials.password !== localCredentials.confirmation) {
		issues.push({ code: 'custom', path: ['confirmation'], message: 'Passwords do not match.' });
	}
	return { success: issues.length === 0, error: { issues } };
});
const validation = useFieldValidation(() => credentialValidationResult.value);
const credentialsValid = computed(() => credentialValidationResult.value.success);
const accountDescription = computed(() =>
	`Signed in as ${authentication.state?.identity?.displayName ?? 'Administrator'} via ${authentication.state?.identity?.provider ?? 'Moirai'}.`);

/** Create the local fallback account or rotate its credentials after current-password verification. */
async function saveCredentials(): Promise<void> {
	credentialMessage.value = '';
	credentialError.value = '';
	if (savingCredentials.value || !credentialsValid.value) {
		return;
	}

	savingCredentials.value = true;
	const creating = !hasLocalAccount.value;
	try {
		await authentication.saveLocalCredentials({
			username: localCredentials.username,
			password: localCredentials.password,
			currentPassword: hasLocalAccount.value ? localCredentials.currentPassword : null,
		});
		localCredentials.currentPassword = '';
		localCredentials.password = '';
		localCredentials.confirmation = '';
		validation.reset();
		credentialMessage.value = creating
			? 'Local fallback account created.'
			: 'Local credentials updated.';
	}
	catch (cause) {
		credentialError.value = errorMessage(cause);
	}
	finally {
		savingCredentials.value = false;
	}
}
</script>

<template>
	<section>
		<PageHeader
			eyebrow="Administrator access"
			title="Account"
			:description="accountDescription"
		/>
		<div class="account-layout">
			<form class="panel form-grid account-panel" @submit.prevent="saveCredentials">
				<div class="span-2">
					<p class="eyebrow">Local access</p>
					<h2>{{ hasLocalAccount ? 'Local credentials' : 'Local fallback account' }}</h2>
					<p>
						{{ hasLocalAccount
							? 'Change the singleton local administrator username and password.'
							: 'Create local credentials that remain available if Logto cannot be reached.' }}
					</p>
				</div>
				<p v-if="credentialError" class="notice error span-2">{{ credentialError }}</p>
				<label class="span-2">
					<span>Username</span>
					<input v-model="localCredentials.username" v-bind="validation.attributes('username')" minlength="3" maxlength="64" required />
					<small v-if="validation.error('username')" :id="validation.errorId('username')" class="field-error">{{ validation.error('username') }}</small>
				</label>
				<label v-if="hasLocalAccount" class="span-2">
					<span>Current password</span>
					<input
						v-model="localCredentials.currentPassword" v-bind="validation.attributes('currentPassword')"
						type="password"
						autocomplete="current-password"
						maxlength="256"
						required
					/>
					<small v-if="validation.error('currentPassword')" :id="validation.errorId('currentPassword')" class="field-error">{{ validation.error('currentPassword') }}</small>
				</label>
				<label class="span-2">
					<span>New password</span>
					<input
						v-model="localCredentials.password" v-bind="validation.attributes('password', passwordHelpId)"
						type="password"
						autocomplete="new-password"
						minlength="15"
						maxlength="256"
						required
					/>
					<small v-if="validation.error('password')" :id="validation.errorId('password')" class="field-error">{{ validation.error('password') }}</small>
					<small :id="passwordHelpId">Use at least 15 characters.</small>
				</label>
				<label class="span-2">
					<span>Confirm new password</span>
					<input
						v-model="localCredentials.confirmation" v-bind="validation.attributes('confirmation')"
						type="password"
						autocomplete="new-password"
						minlength="15"
						maxlength="256"
						required
					/>
					<small v-if="validation.error('confirmation')" :id="validation.errorId('confirmation')" class="field-error">{{ validation.error('confirmation') }}</small>
				</label>
				<div class="form-actions span-2">
					<button class="button" :disabled="savingCredentials || !credentialsValid">
						<KeyRound :size="17" />{{ hasLocalAccount ? 'Update Credentials' : 'Create Local Account' }}
					</button>
				</div>
			</form>
		</div>
		<TransientToast v-if="credentialMessage" :message="credentialMessage" @close="credentialMessage = ''" />
	</section>
</template>
