<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { KeyRound } from '@lucide/vue';
import { errorMessage } from '../error-message';
import PageHeader from '../components/PageHeader.vue';
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
const accountDescription = computed(() =>
	`Signed in as ${authentication.state?.identity?.displayName ?? 'Administrator'} via ${authentication.state?.identity?.provider ?? 'Moirai'}.`);

/** Create the local fallback account or rotate its credentials after current-password verification. */
async function saveCredentials(): Promise<void> {
	credentialMessage.value = '';
	credentialError.value = '';
	if (localCredentials.password !== localCredentials.confirmation) {
		credentialError.value = 'New passwords do not match.';
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
				<p v-if="credentialMessage" class="notice success span-2">{{ credentialMessage }}</p>
				<p v-if="credentialError" class="notice error span-2">{{ credentialError }}</p>
				<label class="span-2">
					<span>Username</span>
					<input v-model="localCredentials.username" minlength="3" maxlength="64" required />
				</label>
				<label v-if="hasLocalAccount" class="span-2">
					<span>Current password</span>
					<input
						v-model="localCredentials.currentPassword"
						type="password"
						autocomplete="current-password"
						required
					/>
				</label>
				<label class="span-2">
					<span>New password</span>
					<input
						v-model="localCredentials.password"
						type="password"
						autocomplete="new-password"
						minlength="15"
						maxlength="256"
						required
					/>
					<small>Use at least 15 characters.</small>
				</label>
				<label class="span-2">
					<span>Confirm new password</span>
					<input
						v-model="localCredentials.confirmation"
						type="password"
						autocomplete="new-password"
						minlength="15"
						maxlength="256"
						required
					/>
				</label>
				<div class="form-actions span-2">
					<button class="button" :disabled="savingCredentials">
						<KeyRound :size="17" />{{ hasLocalAccount ? 'Update credentials' : 'Create local account' }}
					</button>
				</div>
			</form>
		</div>
	</section>
</template>
